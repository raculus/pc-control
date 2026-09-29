<img width="20%" alt="image" src="https://github.com/raculus/pc-control-server/blob/main/public/icon.png?raw=true" />

# 컴퓨터 제어 서버
라즈베리파이에서 대상 컴퓨터로 ping 하여 사용중 여부 파악 및 시간 소진 후 ssh로 종료

## 클라이언트
https://apps.microsoft.com/store/detail/9NCF9P81VDZ6?cid=DevShareMCLPCS
https://github.com/raculus/pc-control-client

## 도커 이미지
https://hub.docker.com/repository/docker/raculus/pc-control

docker-compose.yml
```
services:
  pc-control:
    image: raculus/pc-control:latest
    container_name: pc-control
    restart: always
    network_mode: host
    environment:
      - PORT=3003
    volumes:
      - /DATA/AppData/pc-controller/data:/app/data
```
# 스크린샷
<img width="50%" alt="image" src="https://github.com/user-attachments/assets/2525cba9-f566-4ea6-81a3-bb499de46af7" />
<img width="50%" alt="image" src="https://github.com/user-attachments/assets/93aa7418-e5bc-4dd1-bdb9-5fbb751e1234" />
<img width="50%" alt="image" src="https://github.com/user-attachments/assets/e5de9205-561f-4afb-92ab-382f7a0a50e6" />
<img width="50%" alt="image" src="https://github.com/user-attachments/assets/2d48f763-1741-451d-9143-3892d7fe7a25" />
