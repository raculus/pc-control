const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
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

function getKSTISOString() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().replace('T', ' ').substring(0, 19);
}

// 로그 생성 헬퍼 함수 (최대 50개 보관)
function addLog(pc, type, message) {
  if (!pc.logs) pc.logs = [];
  pc.logs.unshift({
    timestamp: getKSTISOString(),
    type, // 'PING', 'SHUTDOWN', 'TIME_CHANGE'
    message
  });
  if (pc.logs.length > 50) pc.logs.pop();
}

// 디스코드 웹훅 전송 함수
function sendDiscordWebhook(webhookUrl, pcName, ip, message) {
  if (!webhookUrl) return;

  const payload = JSON.stringify({
    username: "PC 모니터링 알림",
    avatar_url: "https://github.com/raculus/pc-control-server/blob/main/public/icon.png?raw=true",
    content: `**[경고] PC SSH 접속 실패 알림**`,
    embeds: [{
      title: `PC: ${pcName} (${ip})`,
      description: message,
      color: 15158332, // Red
      timestamp: new Date().toISOString()
    }]
  });

  try {
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    });

    req.on('error', (e) => console.error('[Discord Webhook Error]', e.message));
    req.write(payload);
    req.end();
  } catch (err) {
    console.error('[Discord URL Error]', err.message);
  }
}

// 웹훅 테스트 API
app.post('/api/admin/webhook/test', checkAuth, (req, res) => {
  const { discord_webhook_url } = req.body;
  
  if (!discord_webhook_url) {
    return res.status(400).json({ success: false, message: '웹훅 URL을 입력해주세요.' });
  }

  try {
    const payload = JSON.stringify({
      username: "PC 모니터링 알림",
      avatar_url: "https://github.com/raculus/pc-control-server/blob/main/public/icon.png?raw=true",
      content: `✅ **디스코드 웹훅 연동 성공**`,
      embeds: [{
        title: `연동 성공`,
        description: `디스코드 웹훅이 성공적으로 연동되었습니다.`,
        color: 3066993, // Green
        timestamp: new Date().toISOString()
      }]
    });

    const url = new URL(discord_webhook_url);
    const reqDiscord = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    });

    reqDiscord.on('error', (e) => {
      console.error('[Discord Webhook Test Error]', e.message);
      res.status(500).json({ success: false, message: '웹훅 전송 중 오류 발생: ' + e.message });
    });

    reqDiscord.write(payload);
    reqDiscord.end();

    res.json({ success: true, message: '테스트 메시지가 전송되었습니다.' });
  } catch (err) {
    res.status(400).json({ success: false, message: '올바르지 않은 Webhook URL 형식입니다.' });
  }
});

// SSH Port(22) 오픈 여부 확인 헬퍼 함수
function checkSshPort(ip, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isConnected = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      isConnected = true;
      socket.destroy();
    });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => resolve(isConnected));

    socket.connect(22, ip);
  });
}

// SSH 원격 종료 함수
function shutdownPCviaSSH(ip, user, password, pc) {
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

// 날짜 변경 감지 및 자정 리필
let lastRefillDate = new Date().toDateString();
setInterval(() => {
  const currentDate = new Date().toDateString();
  if (currentDate !== lastRefillDate) {
    lastRefillDate = currentDate;
    try {
      const store = db.read();
      const currentDayOfWeek = new Date().getDay();

      store.pcs.forEach((pc) => {
        if (pc.schedules && Array.isArray(pc.schedules)) {
          const todaySchedule = pc.schedules.find(s => s.day_of_week === currentDayOfWeek);
          if (todaySchedule) {
            pc.remaining_seconds = todaySchedule.default_minutes * 60;
            addLog(pc, 'TIME_CHANGE', `[자정 리필] 기본 시간 ${todaySchedule.default_minutes}분 설정`);
          }
        }
      });
      db.write(store);
    } catch (err) {
      console.error("[Refill Error]", err.message);
    }
  }
}, 60000);

// 백그라운드 30초 감시 및 SSH 상태 체크
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
      const webhookUrl = store.admin_config ? store.admin_config.discord_webhook_url : '';

      store.pcs.forEach(async (pc) => {
        const targetMac = pc.mac.toLowerCase();
        const currentIp = arpMap.get(targetMac) || pc.ip;

        if (arpMap.has(targetMac) && currentIp !== pc.ip) {
          pc.ip = currentIp;
        }

        const pingCmd = process.platform === 'win32' 
          ? `ping -n 1 -w 1000 ${currentIp}` 
          : `ping -c 1 -W 1 ${currentIp}`;

        exec(pingCmd, async (error) => {
          const isOnline = !error ? 1 : 0;
          const kstNow = getKSTISOString();

          if (isOnline) {
            let deduct = 30;

            if (pc.remaining_seconds > 0) {
              if (pc.remaining_seconds >= deduct) {
                pc.remaining_seconds -= deduct;
                deduct = 0;
              } else {
                deduct -= pc.remaining_seconds;
                pc.remaining_seconds = 0;
              }
            }

            if (deduct > 0 && pc.bonus_seconds > 0) {
              pc.bonus_seconds = Math.max(0, pc.bonus_seconds - deduct);
            }

            const totalRemaining = pc.remaining_seconds + (pc.bonus_seconds || 0);

            if (pc.is_online === 0) {
              pc.is_online = 1;
              pc.ip = currentIp;
              pc.last_seen = kstNow;
              pc.last_booted_at = kstNow;
              addLog(pc, 'PING', `Ping 응답 성공 (온라인 감지)`);
            } else {
              pc.is_online = 1;
              pc.ip = currentIp;
              pc.last_seen = kstNow;
            }

            // SSH 포트 상태 점검 (Ping 성공 조건 하에서 수행)
            const sshOk = await checkSshPort(currentIp);
            if (!sshOk) {
              // 최초 실패 시에만 디스코드 알림 발송 (도배 방지)
              if (!pc.ssh_failed) {
                pc.ssh_failed = true;
                addLog(pc, 'PING', `Ping은 도달하나 SSH 접속(22번 포트) 실패`);
                sendDiscordWebhook(webhookUrl, pc.name, currentIp, `Ping 응답은 정상이지만 SSH(Port 22) 응답이 없습니다.`);
              }
            } else {
              pc.ssh_failed = false;
            }

            if (totalRemaining === 0) {
              addLog(pc, 'SHUTDOWN', `시간 소진으로 인한 원격 종료 실행`);
              shutdownPCviaSSH(currentIp, pc.ssh_user, pc.ssh_password, pc);
            }
          } else {
            if (pc.is_online === 1) {
              addLog(pc, 'PING', `Ping 응답 없음 (오프라인 전환)`);
            }
            pc.is_online = 0;
            pc.ssh_failed = false;
          }

          db.write(store);
        });
      });
    } catch (dbErr) {
      console.error("[Timer Error] DB 작업 에러:", dbErr.message);
    }
  });
}, 30000);

// Admin API
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

// 웹훅 설정 가져오기 및 저장 API
app.get('/api/admin/webhook', checkAuth, (req, res) => {
  const store = db.read();
  res.json({ discord_webhook_url: store.admin_config?.discord_webhook_url || '' });
});

app.post('/api/admin/webhook', checkAuth, (req, res) => {
  const { discord_webhook_url } = req.body;
  const store = db.read();
  if (!store.admin_config) store.admin_config = {};
  store.admin_config.discord_webhook_url = discord_webhook_url || '';
  db.write(store);
  res.json({ success: true });
});

// LAN ARP 탐색
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
    bonus_seconds: pc.bonus_seconds || 0,
    is_online: pc.is_online,
    ssh_failed: pc.ssh_failed || false,
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
      bonus_seconds: 0,
      is_online: 0,
      ssh_failed: false,
      last_seen: null,
      last_booted_at: null,
      schedules: defaultSchedules,
      logs: []
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

  const { schedules, logs, ...pcData } = pc;
  res.json({ pc: pcData, schedules: schedules || [], logs: logs || [] });
});

app.post('/api/pcs/:id/adjust-time', checkAuth, (req, res) => {
  const pcId = parseInt(req.params.id);
  const { minutes } = req.body;
  const addSeconds = minutes * 60;

  const store = db.read();
  const pc = store.pcs.find(p => p.id === pcId);
  if (pc) {
    pc.remaining_seconds = Math.max(0, pc.remaining_seconds + addSeconds);
    const actionStr = minutes >= 0 ? `+${minutes}분 추가` : `${minutes}분 차감`;
    addLog(pc, 'TIME_CHANGE', `기본 시간 ${actionStr}`);
    db.write(store);
  }
  res.json({ success: true });
});

app.post('/api/pcs/:id/adjust-bonus-time', checkAuth, (req, res) => {
  const pcId = parseInt(req.params.id);
  const { minutes } = req.body;
  const addSeconds = minutes * 60;

  const store = db.read();
  const pc = store.pcs.find(p => p.id === pcId);
  if (pc) {
    if (!pc.bonus_seconds) pc.bonus_seconds = 0;
    pc.bonus_seconds = Math.max(0, pc.bonus_seconds + addSeconds);
    const actionStr = minutes >= 0 ? `+${minutes}분 추가` : `${minutes}분 차감`;
    addLog(pc, 'TIME_CHANGE', `보너스 시간 ${actionStr}`);
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
      addLog(pc, 'TIME_CHANGE', `전체 요일 기본 시간 ${cappedMinutes}분 일괄 설정`);
    } else {
      const targetDay = parseInt(day_of_week);
      const schedule = pc.schedules.find(s => s.day_of_week === targetDay);
      if (schedule) schedule.default_minutes = cappedMinutes;
      const days = ['일', '월', '화', '수', '목', '금', '토'];
      addLog(pc, 'TIME_CHANGE', `${days[targetDay]}요일 기본 시간 ${cappedMinutes}분 설정`);
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
  shutdownPCviaSSH(pc.ip, pc.ssh_user, pc.ssh_password, pc);
  addLog(pc, 'SHUTDOWN', `관리자 즉시 종료 명령 전송`);
  db.write(store);
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