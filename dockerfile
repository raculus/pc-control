FROM node:20-slim

RUN apt-get update && apt-get install -y \
    net-tools \
    iputils-ping \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=3000
EXPOSE ${PORT}

CMD ["node", "server.js"]