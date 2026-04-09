// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public 폴더의 정적 파일 서빙
app.use(express.static('public'));

// 게임 상태 저장
const players = {};

io.on('connection', (socket) => {
    console.log(`플레이어 접속: ${socket.id}`);

    // 새 플레이어 초기화 (랜덤 시작 위치)
    players[socket.id] = {
        x: Math.random() * 20 - 10,
        y: 1, // 바닥보다 조금 위
        z: Math.random() * 20 - 10,
        rotation: 0,
        hp: 100
    };

    // 현재 접속 중인 모든 플레이어 정보를 방금 접속한 사람에게 전송
    socket.emit('currentPlayers', players);

    // 다른 사람들에게 새로운 플레이어가 접속했음을 알림
    socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });

    // 5단계: 플레이어 이동 동기화
    socket.on('playerMovement', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].z = data.z;
            players[socket.id].rotation = data.rotation;
            // 본인을 제외한 모두에게 이동 정보 브로드캐스팅
            socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] });
        }
    });

    // 6단계: 타격 판정 및 체력 시스템
    socket.on('hit', (targetId) => {
        if (players[targetId]) {
            players[targetId].hp -= 20; // 20 데미지
            
            if (players[targetId].hp <= 0) {
                // 사망 및 리스폰 처리
                players[targetId].hp = 100;
                players[targetId].x = Math.random() * 20 - 10;
                players[targetId].z = Math.random() * 20 - 10;
                
                // 타격받은 유저에게 리스폰 명령 전송
                io.to(targetId).emit('respawn', players[targetId]);
            } else {
                // 체력 업데이트 알림
                io.to(targetId).emit('hpUpdate', players[targetId].hp);
            }
            
            // 모든 유저에게 상태 업데이트 (옵션)
            io.emit('playerMoved', { id: targetId, ...players[targetId] });
        }
    });

    // 접속 해제 시
    socket.on('disconnect', () => {
        console.log(`플레이어 접속 해제: ${socket.id}`);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});