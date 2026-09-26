const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs'); // <--- fs 모듈 정의
const { exec } = require('child_process');
const { Client } = require('ssh2');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'raspberry_pi_multi_pc_secret',
  resave: false,
  saveUninitialized: true
}));

const checkAuth = (req, res, next) => {
  if (req.session.authenticated) next();
  else res.status(401).json({ error: '인증 필요' });
};

// 한국 시간(KST) ISO 규격 문자열 생성 헬퍼
function getKSTISOString() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().replace('Z', '');
}

// MAC 주소 기반 남은 시간 조회
app.get('/api/client/status-by-mac', (req, res) => {
  const mac = req.query.mac;
  if (!mac) return res.status(400).json({ error: 'MAC 주소가 필요합니다.' });

  try {
    const data = db.read();
    const cleanMac = mac.trim().toLowerCase();
    const pc = data.pcs.find(p => p.mac.trim().toLowerCase() === cleanMac);

    if (!pc) {
      return res.status(404).json({ error: '등록되지 않은 PC입니다.' });
    }

    const totalMinutes = Math.floor(pc.remaining_seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    res.json({
      id: pc.id,
      name: pc.name,
      remaining_seconds: pc.remaining_seconds,
      hours: hours,
      minutes: minutes,
      should_shutdown: pc.remaining_seconds <= 0,
      last_booted_at: pc.last_booted_at
    });
  } catch (err) {
    res.status(500).json({ error: 'DB 조회 실패' });
  }
});

// SSH 원격 종료 함수
function shutdownPCviaSSH(ip, user, password) {
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec('shutdown /s /t 60 /f || shutdown -h now', (err, stream) => {
      if (stream) stream.on('close', () => conn.end());
      else conn.end();
    });
  }).on('error', (err) => {
    console.error(`[SSH Error] ${ip}:`, err.message);
  }).connect({
    host: ip,
    port: 22,
    username: user || 'administrator',
    password: password || '',
    readyTimeout: 5000
  });
}

// 백그라운드 30초 감시 및 시간 차감 타이머
setInterval(() => {
  exec('arp -a', (err, stdout) => {
    if (err) return;

    const arpMap = new Map();
    const lines = stdout.split('\n');
    const ipMacRegex = /((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2})/i;

    lines.forEach(line => {
      const match = line.match(ipMacRegex);
      if (match) {
        const ip = match[1];
        const mac = match[2].replace(/-/g, ':').toLowerCase();
        arpMap.set(mac, ip);
      }
    });

    try {
      const store = db.read();

      store.pcs.forEach((pc) => {
        const targetMac = pc.mac.toLowerCase();
        const currentIp = arpMap.get(targetMac) || pc.ip;

        if (arpMap.has(targetMac) && currentIp !== pc.ip) {
          pc.ip = currentIp;
        }

        const pingCmd = process.platform === 'win32' 
          ? `ping -n 1 -w 1000 ${currentIp}` 
          : `ping -c 1 -W 1 ${currentIp}`;

        exec(pingCmd, (error) => {
          const isOnline = !error ? 1 : 0;
          const kstNow = getKSTISOString();

          if (isOnline) {
            let newTime = Math.max(0, pc.remaining_seconds - 30);
            
            if (pc.is_online === 0) {
              console.log(`[부팅 감지] ${pc.name}(${currentIp}) PC 최초 켜짐 시점 기록`);
              pc.is_online = 1;
              pc.ip = currentIp;
              pc.remaining_seconds = newTime;
              pc.last_seen = kstNow;
              pc.last_booted_at = kstNow;
            } else {
              pc.is_online = 1;
              pc.ip = currentIp;
              pc.remaining_seconds = newTime;
              pc.last_seen = kstNow;
            }

            if (newTime === 0 && pc.remaining_seconds > 0) {
              console.log(`[시간 소진] ${pc.name}(${currentIp}) 원격 종료 요청`);
              shutdownPCviaSSH(currentIp, pc.ssh_user, pc.ssh_password);
            }
          } else {
            pc.is_online = 0;
          }

          db.write(store);
        });
      });
    } catch (dbErr) {
      console.error("[Timer Error] DB 작업 에러:", dbErr.message);
    }
  });
}, 30000);

// API 엔드포인트
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const store = db.read();

  if (store.admin_config && store.admin_config.admin_password === password) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
  }
});

app.post('/api/admin/change-password', checkAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const store = db.read();

  if (store.admin_config && store.admin_config.admin_password === currentPassword) {
    store.admin_config.admin_password = newPassword;
    db.write(store);
    res.json({ success: true });
  } else {
    res.status(400).json({ message: '현재 비밀번호 불일치' });
  }
});

// LAN ARP 탐색 목록 가져오기 (fs 활용)
app.get('/api/lan/devices', checkAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  if (fs.existsSync('/proc/net/arp')) {
    try {
      const content = fs.readFileSync('/proc/net/arp', 'utf-8');
      const lines = content.split('\n').slice(1);
      const devices = [];

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const ip = parts[0];
          const flags = parts[2];
          const mac = parts[3];

          if (flags !== '0x0' && mac && mac !== '00:00:00:00:00:00') {
            const formattedMac = mac.split(':').map(hex => hex.padStart(2, '0')).join(':').toLowerCase();
            if (!devices.some(d => d.mac === formattedMac) && !ip.startsWith('127.')) {
              devices.push({ ip, mac: formattedMac });
            }
          }
        }
      });

      return res.json(devices);
    } catch (e) {
      console.error('[ARP Read Error]', e);
    }
  }

  exec('arp -a', (err, stdout) => {
    if (err) return res.json([]);
    const devices = [];
    const ipMacRegex = /((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2})/i;

    stdout.split('\n').forEach(line => {
      const match = line.match(ipMacRegex);
      if (match) {
        const ip = match[1];
        const mac = match[2].replace(/-/g, ':').toLowerCase();
        if (!devices.some(d => d.mac === mac)) {
          devices.push({ ip, mac });
        }
      }
    });
    res.json(devices);
  });
});

app.get('/api/pcs', checkAuth, (req, res) => {
  const store = db.read();
  const rows = store.pcs.map(pc => ({
    id: pc.id,
    name: pc.name,
    ip: pc.ip,
    mac: pc.mac,
    ssh_user: pc.ssh_user,
    remaining_seconds: pc.remaining_seconds,
    is_online: pc.is_online,
    last_booted_at: pc.last_booted_at
  }));
  res.json(rows || []);
});

app.post('/api/pcs', checkAuth, (req, res) => {
  const { name, ip, mac, ssh_user, ssh_password } = req.body;
  const cleanMac = mac ? mac.trim().toLowerCase() : '';
  const cleanIp = ip ? ip.trim() : '';

  try {
    const store = db.read();
    if (store.pcs.some(p => p.mac.toLowerCase() === cleanMac)) {
      return res.status(400).json({ error: '이미 등록된 MAC 주소입니다.' });
    }

    const newId = store.pcs.length > 0 ? Math.max(...store.pcs.map(p => p.id)) + 1 : 1;
    const defaultSchedules = [];
    for (let i = 0; i < 7; i++) {
      defaultSchedules.push({ day_of_week: i, default_minutes: 60 });
    }

    const newPc = {
      id: newId,
      name: name.trim(),
      ip: cleanIp,
      mac: cleanMac,
      ssh_user: ssh_user || 'administrator',
      ssh_password: ssh_password || '',
      remaining_seconds: 0,
      is_online: 0,
      last_seen: null,
      last_booted_at: null,
      schedules: defaultSchedules
    };

    store.pcs.push(newPc);
    db.write(store);

    res.json({ success: true, pcId: newId });
  } catch (err) {
    res.status(400).json({ error: 'PC 등록 실패' });
  }
});

app.get('/api/pcs/:id', checkAuth, (req, res) => {
  const pcId = parseInt(req.params.id);
  const store = db.read();
  const pc = store.pcs.find(p => p.id === pcId);

  if (!pc) return res.status(404).json({ error: 'PC를 찾을 수 없습니다.' });

  const { schedules, ...pcData } = pc;
  res.json({ pc: pcData, schedules: schedules || [] });
});

app.post('/api/pcs/:id/adjust-time', checkAuth, (req, res) => {
  const pcId = parseInt(req.params.id);
  const { minutes } = req.body;
  const addSeconds = minutes * 60;

  const store = db.read();
  const pc = store.pcs.find(p => p.id === pcId);
  if (pc) {
    pc.remaining_seconds = Math.max(0, pc.remaining_seconds + addSeconds);
    db.write(store);
  }
  res.json({ success: true });
});

app.post('/api/pcs/:id/update-schedule', checkAuth, (req, res) => {
  const pcId = parseInt(req.params.id);
  let { day_of_week, default_minutes } = req.body;
  const cappedMinutes = Math.min(1440, Math.max(0, parseInt(default_minutes) || 0));

  const store = db.read();
  const pc = store.pcs.find(p => p.id === pcId);

  if (pc) {
    if (day_of_week === 'bulk') {
      pc.schedules.forEach(s => s.default_minutes = cappedMinutes);
    } else {
      const targetDay = parseInt(day_of_week);
      const schedule = pc.schedules.find(s => s.day_of_week === targetDay);
      if (schedule) schedule.default_minutes = cappedMinutes;
    }
    db.write(store);
  }
  res.json({ success: true, default_minutes: cappedMinutes });
});

app.post('/api/pcs/:id/shutdown-now', checkAuth, (req, res) => {
  const pcId = parseInt(req.params.id);
  const store = db.read();
  const pc = store.pcs.find(p => p.id === pcId);

  if (!pc) return res.status(404).json({ error: 'PC 없음' });
  shutdownPCviaSSH(pc.ip, pc.ssh_user, pc.ssh_password);
  res.json({ success: true, message: '종료 명령을 전송했습니다.' });
});

app.delete('/api/pcs/:id', checkAuth, (req, res) => {
  const pcId = parseInt(req.params.id);
  const store = db.read();
  store.pcs = store.pcs.filter(p => p.id !== pcId);
  db.write(store);
  res.json({ success: true });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});