FROM node:20-slim

# ARP/Ping 도구만 최소한으로 설치 (C++ 빌드 도구 완전 제거)
RUN apt-get update && apt-get install -y \
    net-tools \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=3003
EXPOSE ${PORT}

CMD ["node", "server.js"]