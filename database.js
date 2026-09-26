const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pc_control.db');

db.serialize(() => {
  // 관리자 설정 (비밀번호)
  db.run(`CREATE TABLE IF NOT EXISTS admin_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    admin_password TEXT NOT NULL
  )`);

  // 등록된 PC 목록
  db.run(`CREATE TABLE IF NOT EXISTS pcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    mac TEXT NOT NULL UNIQUE,
    ssh_user TEXT DEFAULT 'administrator',
    ssh_password TEXT,
    remaining_seconds INTEGER DEFAULT 0,
    is_online INTEGER DEFAULT 0,
    last_seen DATETIME,
    last_booted_at DATETIME
  )`);

  // PC별 요일별 기본 시간 (분 단위)
  db.run(`CREATE TABLE IF NOT EXISTS pc_schedules (
    pc_id INTEGER,
    day_of_week INTEGER,
    default_minutes INTEGER DEFAULT 60,
    PRIMARY KEY (pc_id, day_of_week),
    FOREIGN KEY (pc_id) REFERENCES pcs(id) ON DELETE CASCADE
  )`);

  // 초기 관리자 암호 설정 (admin1234)
  db.get("SELECT count(*) as count FROM admin_config", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO admin_config (id, admin_password) VALUES (1, 'admin1234')");
    }
  });
});

module.exports = db;