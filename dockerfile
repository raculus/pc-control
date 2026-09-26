FROM node:18-slim

# arp 명령어 실행을 위한 net-tools 및 ping 관련 도구 설치
RUN apt-get update && apt-get install -y \
    net-tools \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# 기본 포트 환경변수 설정 (docker-compose 등에서 지정 안 할 경우 3000 사용)
ENV PORT=3000

# 컨테이너 기본 안내 포트
EXPOSE ${PORT}

CMD ["node", "server.js"]