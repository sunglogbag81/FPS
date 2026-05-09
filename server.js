const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
});

app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE = 20;
const WORLD_SIZE = 92;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.55;
const MAX_SHOT_DISTANCE = 120;
const DAMAGE = 25;
const RESPAWN_MS = 1200;
const BOT_COUNT = Number(process.env.BOT_COUNT || 6);
const BOT_FIRE_COOLDOWN_MS = 850;
const BOT_AGGRO_RANGE = 55;
const BOT_SPEED = 0.42;

const map = {
  worldSize: WORLD_SIZE,
  obstacles: [
    { x: 0, z: -18, w: 8, d: 8, h: 7 },
    { x: -22, z: -8, w: 7, d: 15, h: 5 },
    { x: 23, z: 10, w: 12, d: 7, h: 6 },
    { x: -8, z: 25, w: 18, d: 5, h: 4 },
    { x: 34, z: -28, w: 9, d: 9, h: 8 },
    { x: -35, z: 28, w: 10, d: 10, h: 8 },
    { x: 0, z: 0, w: 5, d: 5, h: 4 },
    { x: 41, z: 2, w: 6, d: 24, h: 5 },
    { x: -42, z: -28, w: 8, d: 18, h: 5 },
    { x: 12, z: 39, w: 22, d: 6, h: 5 },
  ],
  spawns: [
    { x: -36, y: PLAYER_HEIGHT, z: -36 },
    { x: 36, y: PLAYER_HEIGHT, z: 36 },
    { x: -36, y: PLAYER_HEIGHT, z: 36 },
    { x: 36, y: PLAYER_HEIGHT, z: -36 },
    { x: 0, y: PLAYER_HEIGHT, z: 42 },
    { x: 0, y: PLAYER_HEIGHT, z: -42 },
  ],
};

const players = new Map();
let spawnIndex = 0;
let botSeq = 0;

function now() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pickSpawn() {
  const spawn = map.spawns[spawnIndex % map.spawns.length];
  spawnIndex += 1;
  return { ...spawn };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    hp: player.hp,
    score: player.score,
    deaths: player.deaths,
    alive: player.alive,
    isBot: Boolean(player.isBot),
  };
}

function snapshot() {
  return {
    serverTime: now(),
    players: [...players.values()].map(publicPlayer),
  };
}

function isPointInsideObstacle(x, z, obstacle, padding = PLAYER_RADIUS) {
  return (
    x > obstacle.x - obstacle.w / 2 - padding &&
    x < obstacle.x + obstacle.w / 2 + padding &&
    z > obstacle.z - obstacle.d / 2 - padding &&
    z < obstacle.z + obstacle.d / 2 + padding
  );
}

function sanitizePosition(player, data) {
  const previous = { x: player.x, y: player.y, z: player.z };
  const x = Number(data.x);
  const y = Number(data.y);
  const z = Number(data.z);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return previous;

  const maxStep = 4.5;
  const nx = clamp(x, player.x - maxStep, player.x + maxStep);
  const nz = clamp(z, player.z - maxStep, player.z + maxStep);
  const ny = clamp(y, PLAYER_HEIGHT, 12);
  const bounded = {
    x: clamp(nx, -WORLD_SIZE / 2, WORLD_SIZE / 2),
    y: ny,
    z: clamp(nz, -WORLD_SIZE / 2, WORLD_SIZE / 2),
  };

  const blocked = map.obstacles.some((obstacle) => isPointInsideObstacle(bounded.x, bounded.z, obstacle));
  return blocked ? previous : bounded;
}

function rayIntersectsAabb(origin, dir, obstacle) {
  const min = { x: obstacle.x - obstacle.w / 2, y: 0, z: obstacle.z - obstacle.d / 2 };
  const max = { x: obstacle.x + obstacle.w / 2, y: obstacle.h, z: obstacle.z + obstacle.d / 2 };
  let tmin = 0;
  let tmax = MAX_SHOT_DISTANCE;

  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(dir[axis]) < 1e-6) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
    } else {
      const inv = 1 / dir[axis];
      let t1 = (min[axis] - origin[axis]) * inv;
      let t2 = (max[axis] - origin[axis]) * inv;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : tmax;
}

function rayIntersectsPlayer(origin, dir, player) {
  if (!player.alive) return null;
  const center = { x: player.x, y: player.y, z: player.z };
  const oc = { x: origin.x - center.x, y: origin.y - center.y, z: origin.z - center.z };
  const radius = 0.75;
  const b = oc.x * dir.x + oc.y * dir.y + oc.z * dir.z;
  const c = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > MAX_SHOT_DISTANCE) return null;
  return t;
}

function normalizeDirection(dir) {
  const x = Number(dir?.x);
  const y = Number(dir?.y);
  const z = Number(dir?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  const len = Math.hypot(x, y, z);
  if (len < 0.001) return null;
  return { x: x / len, y: y / len, z: z / len };
}

function respawn(player) {
  const spawn = pickSpawn();
  Object.assign(player, spawn, { hp: 100, alive: true, invulnerableUntil: now() + 1200 });
  io.emit('playerRespawned', publicPlayer(player));
}


function damagePlayer(target, attacker, t) {
  if (!target || !target.alive || target.invulnerableUntil >= t) return false;
  target.hp = Math.max(0, target.hp - DAMAGE);

  if (!target.isBot) {
    io.to(target.id).emit('damaged', { hp: target.hp, by: attacker.id });
  }

  if (target.hp <= 0) {
    target.alive = false;
    target.deaths += 1;
    attacker.score += 1;
    io.emit('playerKilled', { killer: publicPlayer(attacker), victim: publicPlayer(target) });
    setTimeout(() => {
      if (players.has(target.id)) respawn(target);
    }, RESPAWN_MS);
  } else {
    io.emit('playerUpdated', publicPlayer(target));
  }
  io.emit('playerUpdated', publicPlayer(attacker));
  return true;
}

function fireShot(player, dir) {
  const t = now();
  if (!player.alive || t - player.lastShotAt < 120) return;
  player.lastShotAt = t;

  const origin = { x: player.x, y: player.y + 0.35, z: player.z };
  let nearest = { t: MAX_SHOT_DISTANCE, type: 'miss', id: null };

  for (const obstacle of map.obstacles) {
    const hitT = rayIntersectsAabb(origin, dir, obstacle);
    if (hitT !== null && hitT < nearest.t) nearest = { t: hitT, type: 'wall', id: null };
  }
  for (const target of players.values()) {
    if (target.id === player.id) continue;
    const hitT = rayIntersectsPlayer(origin, dir, target);
    if (hitT !== null && hitT < nearest.t) nearest = { t: hitT, type: 'player', id: target.id };
  }

  const end = {
    x: origin.x + dir.x * nearest.t,
    y: origin.y + dir.y * nearest.t,
    z: origin.z + dir.z * nearest.t,
  };

  if (nearest.type === 'player') {
    damagePlayer(players.get(nearest.id), player, t);
  }

  io.emit('shot', { shooterId: player.id, origin, end, hit: nearest });
}

function createBot() {
  const spawn = pickSpawn();
  const id = `bot-${++botSeq}`;
  const bot = {
    id,
    name: `BOT-${botSeq}`,
    ...spawn,
    yaw: 0,
    pitch: 0,
    hp: 100,
    score: 0,
    deaths: 0,
    alive: true,
    isBot: true,
    invulnerableUntil: now() + 1000,
    lastShotAt: 0,
    nextThinkAt: 0,
    wanderAngle: Math.random() * Math.PI * 2,
  };
  players.set(id, bot);
  io.emit('playerJoined', publicPlayer(bot));
}

function ensureBots() {
  const current = [...players.values()].filter((player) => player.isBot).length;
  for (let i = current; i < BOT_COUNT; i += 1) createBot();
}

function nearestHuman(bot) {
  let best = null;
  let bestDist = Infinity;
  for (const player of players.values()) {
    if (player.isBot || !player.alive) continue;
    const dist = Math.hypot(player.x - bot.x, player.z - bot.z);
    if (dist < bestDist) {
      best = player;
      bestDist = dist;
    }
  }
  return bestDist <= BOT_AGGRO_RANGE ? best : null;
}

function moveBot(bot, target) {
  if (!bot.alive) return;
  const t = now();
  if (t >= bot.nextThinkAt) {
    bot.nextThinkAt = t + 900 + Math.random() * 900;
    bot.wanderAngle += (Math.random() - 0.5) * 1.8;
  }

  let dx = Math.cos(bot.wanderAngle);
  let dz = Math.sin(bot.wanderAngle);
  if (target) {
    dx = target.x - bot.x;
    dz = target.z - bot.z;
  }
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;

  const next = {
    x: clamp(bot.x + dx * BOT_SPEED, -WORLD_SIZE / 2, WORLD_SIZE / 2),
    z: clamp(bot.z + dz * BOT_SPEED, -WORLD_SIZE / 2, WORLD_SIZE / 2),
  };
  if (!map.obstacles.some((obstacle) => isPointInsideObstacle(next.x, next.z, obstacle))) {
    bot.x = next.x;
    bot.z = next.z;
  } else {
    bot.wanderAngle += Math.PI / 2;
  }
  bot.yaw = Math.atan2(dx, dz);
}

function tickBots() {
  ensureBots();
  for (const bot of players.values()) {
    if (!bot.isBot) continue;
    const target = nearestHuman(bot);
    moveBot(bot, target);
    if (!target || !bot.alive) continue;
    const dist = Math.hypot(target.x - bot.x, target.z - bot.z);
    if (dist > BOT_AGGRO_RANGE || now() - bot.lastShotAt < BOT_FIRE_COOLDOWN_MS) continue;
    const aimNoise = 0.05;
    const dir = normalizeDirection({
      x: target.x - bot.x + (Math.random() - 0.5) * aimNoise * dist,
      y: target.y - bot.y + (Math.random() - 0.5) * 0.22,
      z: target.z - bot.z + (Math.random() - 0.5) * aimNoise * dist,
    });
    if (dir) fireShot(bot, dir);
  }
}

io.on('connection', (socket) => {
  const spawn = pickSpawn();
  const player = {
    id: socket.id,
    name: `Player-${socket.id.slice(0, 4)}`,
    ...spawn,
    yaw: 0,
    pitch: 0,
    hp: 100,
    score: 0,
    deaths: 0,
    alive: true,
    invulnerableUntil: now() + 1500,
    lastShotAt: 0,
  };

  players.set(socket.id, player);
  socket.emit('welcome', { id: socket.id, map, snapshot: snapshot() });
  socket.broadcast.emit('playerJoined', publicPlayer(player));

  socket.on('setName', (name) => {
    const clean = String(name || '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 18);
    if (!clean) return;
    player.name = clean;
    io.emit('playerUpdated', publicPlayer(player));
  });

  socket.on('move', (data = {}) => {
    if (!player.alive) return;
    const pos = sanitizePosition(player, data);
    player.x = pos.x;
    player.y = pos.y;
    player.z = pos.z;
    player.yaw = clamp(Number(data.yaw) || 0, -Math.PI * 2, Math.PI * 2);
    player.pitch = clamp(Number(data.pitch) || 0, -Math.PI / 2, Math.PI / 2);
  });

  socket.on('shoot', (data = {}) => {
    const dir = normalizeDirection(data.dir);
    if (dir) fireShot(player, dir);
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('playerLeft', socket.id);
  });
});

ensureBots();

setInterval(() => {
  tickBots();
  io.emit('snapshot', snapshot());
}, 1000 / TICK_RATE);

app.get('/health', (_req, res) => {
  res.json({ ok: true, players: players.size, bots: [...players.values()].filter((player) => player.isBot).length });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FPS server running at http://localhost:${PORT}`);
});
