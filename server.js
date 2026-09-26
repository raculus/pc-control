const express = require('express');
const session = require('express-session');
const path = require('path');
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

// MAC 주소 기반 남은 시간 조회 (공백 및 대소문자 무시 조건 적용)
app.get('/api/client/status-by-mac', (req, res) => {
  const mac = req.query.mac;
  if (!mac) return res.status(400).json({ error: 'MAC 주소가 필요합니다.' });

  try {
    const pc = db.prepare("SELECT id, name, remaining_seconds, is_online, last_booted_at FROM pcs WHERE LOWER(TRIM(mac)) = LOWER(TRIM(?))").get(mac);

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

// SSH 명령으로 PC 원격 종료 수행 함수
function shutdownPCviaSSH(ip, user, password) {
  const conn = new Client();
  conn.on('ready', () => {
    // Windows 및 Linux 호환 강제 종료 명령 실행
    conn.exec('shutdown /s /t 60 /f || shutdown -h now', (err, stream) => {
      if (stream) {
        stream.on('close', () => conn.end());
      } else {
        conn.end();
      }
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

// -------------------------------------------------------------
// 백그라운드 주기 타이머: 30초마다 MAC/IP 추적 -> Ping 체크, 상태 전환 감지 및 시간 차감
// -------------------------------------------------------------
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
      const pcs = db.prepare("SELECT * FROM pcs").all();

      pcs.forEach((pc) => {
        const targetMac = pc.mac.toLowerCase();
        const currentIp = arpMap.get(targetMac) || pc.ip;

        if (arpMap.has(targetMac) && currentIp !== pc.ip) {
          db.prepare("UPDATE pcs SET ip = ? WHERE id = ?").run(currentIp, pc.id);
        }

        const pingCmd = process.platform === 'win32' 
          ? `ping -n 1 -w 1000 ${currentIp}` 
          : `ping -c 1 -W 1 ${currentIp}`;

        exec(pingCmd, (error) => {
          const isOnline = !error ? 1 : 0;

          if (isOnline) {
            let newTime = Math.max(0, pc.remaining_seconds - 30);
            
            if (pc.is_online === 0) {
              console.log(`[부팅 감지] ${pc.name}(${currentIp}) PC 최초 켜짐 시점 기록`);
              db.prepare(
                "UPDATE pcs SET is_online = 1, ip = ?, remaining_seconds = ?, last_seen = datetime('now', '+9 hours'), last_booted_at = datetime('now', '+9 hours') WHERE id = ?"
              ).run(currentIp, newTime, pc.id);
            } else {
              db.prepare(
                "UPDATE pcs SET is_online = 1, ip = ?, remaining_seconds = ?, last_seen = datetime('now', '+9 hours') WHERE id = ?"
              ).run(currentIp, newTime, pc.id);
            }

            // 시간 소진 시 원격 종료
            if (newTime === 0 && pc.remaining_seconds > 0) {
              console.log(`[시간 소진] ${pc.name}(${currentIp}) 원격 종료 요청`);
              shutdownPCviaSSH(currentIp, pc.ssh_user, pc.ssh_password);
            }
          } else {
            // Ping 실패 시 오프라인 상태로 변경
            db.prepare("UPDATE pcs SET is_online = 0 WHERE id = ?").run(pc.id);
          }
        });
      });
    } catch (dbErr) {
      console.error("[Timer Error] DB 조회/수정 에러:", dbErr.message);
    }
  });
}, 30000);

// ==========================================
// API 엔드포인트
// ==========================================

// 로그인 / 로그인 상태 확인 / 비밀번호 변경
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const row = db.prepare("SELECT admin_password FROM admin_config WHERE id = 1").get();

  if (row && row.admin_password === password) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
  }
});

app.post('/api/admin/change-password', checkAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const row = db.prepare("SELECT admin_password FROM admin_config WHERE id = 1").get();

  if (row && row.admin_password === currentPassword) {
    db.prepare("UPDATE admin_config SET admin_password = ? WHERE id = 1").run(newPassword);
    res.json({ success: true });
  } else {
    res.status(400).json({ message: '현재 비밀번호 불일치' });
  }
});

// 1. LAN ARP 탐색 목록 가져오기
app.get('/api/lan/devices', checkAuth, (req, res) => {
  exec('arp -a', (err, stdout) => {
    if (err) return res.status(500).json({ error: 'ARP 탐색 실패' });

    const devices = [];
    const lines = stdout.split('\n');
    const ipMacRegex = /((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2}[:-][0-9a-fa-f]{2})/i;

    lines.forEach(line => {
      const match = line.match(ipMacRegex);
      if (match) {
        devices.push({
          ip: match[1],
          mac: match[2].replace(/-/g, ':').toLowerCase()
        });
      }
    });

    res.json(devices);
  });
});

// 2. PC 목록 조회
app.get('/api/pcs', checkAuth, (req, res) => {
  const rows = db.prepare("SELECT id, name, ip, mac, ssh_user, remaining_seconds, is_online, last_booted_at FROM pcs").all();
  res.json(rows || []);
});
// 3. PC 신규 등록 API (트랜잭션 적용 및 24시간 제한)
app.post('/api/pcs', checkAuth, (req, res) => {
  const { name, ip, mac, ssh_user, ssh_password } = req.body;
  
  const cleanMac = mac ? mac.trim().toLowerCase() : '';
  const cleanIp = ip ? ip.trim() : '';

  try {
    const insertPc = db.prepare("INSERT INTO pcs (name, ip, mac, ssh_user, ssh_password) VALUES (?, ?, ?, ?, ?)");
    const insertSchedule = db.prepare("INSERT INTO pc_schedules (pc_id, day_of_week, default_minutes) VALUES (?, ?, 60)");

    const createPcWithSchedules = db.transaction((pcData) => {
      const info = insertPc.run(pcData.name, pcData.ip, pcData.mac, pcData.user, pcData.pass);
      const pcId = info.lastInsertRowid;
      for (let i = 0; i < 7; i++) {
        insertSchedule.run(pcId, i);
      }
      return pcId;
    });

    const pcId = createPcWithSchedules({
      name: name.trim(),
      ip: cleanIp,
      mac: cleanMac,
      user: ssh_user || 'administrator',
      pass: ssh_password || ''
    });

    res.json({ success: true, pcId });
  } catch (err) {
    res.status(400).json({ error: '이미 등록되었거나 잘못된 정보입니다.' });
  }
});

// 6. PC 요일별/일괄 시간 수정 (최대 24시간 = 1440분 제한 적용)
app.post('/api/pcs/:id/update-schedule', checkAuth, (req, res) => {
  const pcId = req.params.id;
  let { day_of_week, default_minutes } = req.body;

  // 24시간(1440분) 초과 시 1440분으로 고정, 음수일 경우 0분 고정
  const cappedMinutes = Math.min(1440, Math.max(0, parseInt(default_minutes) || 0));

  if (day_of_week === 'bulk') {
    db.prepare("UPDATE pc_schedules SET default_minutes = ? WHERE pc_id = ?").run(cappedMinutes, pcId);
  } else {
    db.prepare("UPDATE pc_schedules SET default_minutes = ? WHERE pc_id = ? AND day_of_week = ?").run(cappedMinutes, pcId, day_of_week);
  }
  res.json({ success: true, default_minutes: cappedMinutes });
});

// 4. 특정 PC 상세 정보 (개별 설정 및 요일 시간)
app.get('/api/pcs/:id', checkAuth, (req, res) => {
  const pcId = req.params.id;
  const pc = db.prepare("SELECT id, name, ip, mac, ssh_user, remaining_seconds, is_online, last_booted_at FROM pcs WHERE id = ?").get(pcId);
  if (!pc) return res.status(404).json({ error: 'PC를 찾을 수 없습니다.' });

  const schedules = db.prepare("SELECT day_of_week, default_minutes FROM pc_schedules WHERE pc_id = ? ORDER BY day_of_week ASC").all(pcId);
  res.json({ pc, schedules });
});

// 5. PC 시간 증가/차감
app.post('/api/pcs/:id/adjust-time', checkAuth, (req, res) => {
  const pcId = req.params.id;
  const { minutes } = req.body;
  const addSeconds = minutes * 60;

  db.prepare("UPDATE pcs SET remaining_seconds = MAX(0, remaining_seconds + ?) WHERE id = ?").run(addSeconds, pcId);
  res.json({ success: true });
});

// 6. PC 요일별/일괄 시간 수정
app.post('/api/pcs/:id/update-schedule', checkAuth, (req, res) => {
  const pcId = req.params.id;
  const { day_of_week, default_minutes } = req.body;

  if (day_of_week === 'bulk') {
    db.prepare("UPDATE pc_schedules SET default_minutes = ? WHERE pc_id = ?").run(default_minutes, pcId);
  } else {
    db.prepare("UPDATE pc_schedules SET default_minutes = ? WHERE pc_id = ? AND day_of_week = ?").run(default_minutes, pcId, day_of_week);
  }
  res.json({ success: true });
});

// 7. SSH 즉시 종료 실행
app.post('/api/pcs/:id/shutdown-now', checkAuth, (req, res) => {
  const pcId = req.params.id;
  const pc = db.prepare("SELECT ip, ssh_user, ssh_password FROM pcs WHERE id = ?").get(pcId);

  if (!pc) return res.status(404).json({ error: 'PC 없음' });
  shutdownPCviaSSH(pc.ip, pc.ssh_user, pc.ssh_password);
  res.json({ success: true, message: '종료 명령을 전송했습니다.' });
});

// 8. PC 삭제
app.delete('/api/pcs/:id', checkAuth, (req, res) => {
  db.prepare("DELETE FROM pcs WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});