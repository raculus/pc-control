const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

// 초기 데이터 구조 정의
const defaultData = {
  admin_config: {
    admin_password: 'admin1234'
  },
  pcs: []
};

// data 폴더 존재 확인 및 생성
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// DB 파일 없으면 생성
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2), 'utf-8');
}

const dbManager = {
  read() {
    try {
      const content = fs.readFileSync(DB_PATH, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      console.error('[DB Read Error]', err);
      return defaultData;
    }
  },

  write(data) {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DB Write Error]', err);
    }
  }
};

module.exports = dbManager;