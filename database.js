const Database = require('better-sqlite3');
const db = new Database('./pc_control.db');

// WAL 모드 활성화 (성능 및 동시성 향상)
db.pragma('journal_mode = WAL');

// 테이블 생성
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    admin_password TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pcs (
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
  );

  CREATE TABLE IF NOT EXISTS pc_schedules (
    pc_id INTEGER,
    day_of_week INTEGER,
    default_minutes INTEGER DEFAULT 60,
    PRIMARY KEY (pc_id, day_of_week),
    FOREIGN KEY (pc_id) REFERENCES pcs(id) ON DELETE CASCADE
  );
`);

// 초기 관리자 비밀번호 확인 및 생성
const adminRow = db.prepare("SELECT count(*) as count FROM admin_config").get();
if (adminRow.count === 0) {
  db.prepare("INSERT INTO admin_config (id, admin_password) VALUES (1, 'admin1234')").run();
}

module.exports = db;