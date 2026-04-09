// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const players = {};

io.on('connection', (socket) => {
    console.log(`플레이어 접속: ${socket.id}`);

    // 새 플레이어 초기화
    players[socket.id] = {
        x: Math.random() * 20 - 10,
        y: 2,
        z: Math.random() * 20 - 10,
        rx: 0,
        ry: 0,
        hp: 100
    };

    // [BUG FIX] 이벤트명 'currentPlayers' → 'init' 으로 통일 (클라이언트와 일치)
    socket.emit('init', { id: socket.id, players });

    // [BUG FIX] 이벤트명 'newPlayer' → 'playerJoined' 으로 통일
    socket.broadcast.emit('playerJoined', { id: socket.id, ...players[socket.id] });

    // [BUG FIX] 이벤트명 'playerMovement' → 'update' 으로 통일 (클라이언트가 emit하는 이름과 일치)
    socket.on('update', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].z = data.z;
            players[socket.id].rx = data.rx;
            players[socket.id].ry = data.ry;
            socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] });
        }
    });

    // [BUG FIX] 'shoot' 이벤트 서버에서 수신 후 다른 클라이언트에게 브로드캐스트
    socket.on('shoot', (data) => {
        socket.broadcast.emit('playerShot', { id: socket.id, muzzlePos: data.muzzlePos, targetPos: data.targetPos });
    });

    // 타격 판정
    socket.on('hit', (targetId) => {
        if (players[targetId]) {
            players[targetId].hp -= 20;

            if (players[targetId].hp <= 0) {
                players[targetId].hp = 100;
                players[targetId].x = Math.random() * 20 - 10;
                players[targetId].z = Math.random() * 20 - 10;
                io.to(targetId).emit('respawn', { x: players[targetId].x, y: 2, z: players[targetId].z });
                // [BUG FIX] hpUpdate를 {id, hp} 객체로 전송 (클라이언트 기대 형식)
                io.to(targetId).emit('hpUpdate', { id: targetId, hp: 100 });
            } else {
                // [BUG FIX] hpUpdate를 {id, hp} 객체로 전송
                io.to(targetId).emit('hpUpdate', { id: targetId, hp: players[targetId].hp });
            }

            io.emit('playerMoved', { id: targetId, ...players[targetId] });
        }
    });

    // 접속 해제
    socket.on('disconnect', () => {
        console.log(`플레이어 접속 해제: ${socket.id}`);
        delete players[socket.id];
        // [BUG FIX] 이벤트명 'playerDisconnected' → 'playerLeft' 로 통일
        io.emit('playerLeft', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
