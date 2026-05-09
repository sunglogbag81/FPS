import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const socket = io();

const ui = {
  menu: document.querySelector('#menu'),
  play: document.querySelector('#play'),
  name: document.querySelector('#name'),
  hp: document.querySelector('#hp'),
  kills: document.querySelector('#kills'),
  deaths: document.querySelector('#deaths'),
  players: document.querySelector('#players'),
  feed: document.querySelector('#feed'),
  leaderboard: document.querySelector('#leaderboard'),
  damage: document.querySelector('#damage-vignette'),
};

class NeonArena {
  constructor() {
    this.myId = null;
    this.map = null;
    this.remotePlayers = new Map();
    this.playerStats = new Map();
    this.obstacleBoxes = [];
    this.keys = new Set();
    this.velocity = new THREE.Vector3();
    this.canJump = false;
    this.lastSend = 0;
    this.hp = 100;

    this.clock = new THREE.Clock();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x02040a);
    this.scene.fog = new THREE.FogExp2(0x02040a, 0.018);

    this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.1, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(this.renderer.domElement);

    this.controls = new PointerLockControls(this.camera, document.body);
    this.controls.getObject().position.set(0, 1.8, 0);
    this.scene.add(this.controls.getObject());

    this.weapon = new Weapon(this.camera);
    this.camera.add(this.weapon.group);

    this.setupLights();
    this.setupEvents();
    this.setupNetwork();
    this.animate();
  }

  setupLights() {
    this.scene.add(new THREE.HemisphereLight(0x89dfff, 0x05020a, 0.55));
    const key = new THREE.DirectionalLight(0x9be8ff, 1.4);
    key.position.set(30, 60, 20);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    this.scene.add(key);

    const rim = new THREE.PointLight(0xff2f92, 1.5, 80);
    rim.position.set(-30, 12, -30);
    this.scene.add(rim);
  }

  setupEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    document.addEventListener('keydown', (event) => {
      this.keys.add(event.code);
      if (event.code === 'Space' && this.canJump && this.controls.isLocked) {
        this.velocity.y = 8.2;
        this.canJump = false;
      }
    });
    document.addEventListener('keyup', (event) => this.keys.delete(event.code));
    document.addEventListener('mousedown', (event) => {
      if (!this.controls.isLocked) return;
      if (event.button === 0) this.shoot();
    });

    this.controls.addEventListener('lock', () => ui.menu.classList.add('hidden'));
    this.controls.addEventListener('unlock', () => ui.menu.classList.remove('hidden'));
    ui.play.addEventListener('click', () => {
      const name = ui.name.value.trim();
      if (name) socket.emit('setName', name);
      this.controls.lock();
    });
  }

  setupNetwork() {
    socket.on('welcome', ({ id, map, snapshot }) => {
      this.myId = id;
      this.map = map;
      this.buildMap(map);
      const me = snapshot.players.find((p) => p.id === id);
      if (me) this.controls.getObject().position.set(me.x, me.y, me.z);
      this.applySnapshot(snapshot);
      this.feed('접속 완료. 행운을 빌어요.');
    });

    socket.on('snapshot', (snapshot) => this.applySnapshot(snapshot));
    socket.on('playerJoined', (player) => {
      if (player.id !== this.myId) this.ensureRemotePlayer(player);
      this.feed(`${player.name} 입장`);
    });
    socket.on('playerLeft', (id) => {
      const remote = this.remotePlayers.get(id);
      if (remote) {
        this.scene.remove(remote.group);
        remote.dispose();
        this.remotePlayers.delete(id);
      }
      this.playerStats.delete(id);
      this.updateScoreboard();
    });
    socket.on('playerUpdated', (player) => {
      this.playerStats.set(player.id, player);
      if (player.id !== this.myId) this.ensureRemotePlayer(player).setTarget(player);
      this.updateScoreboard();
    });
    socket.on('playerRespawned', (player) => {
      this.playerStats.set(player.id, player);
      if (player.id === this.myId) {
        this.hp = player.hp;
        this.updateHp();
        this.controls.getObject().position.set(player.x, player.y, player.z);
        this.velocity.set(0, 0, 0);
        this.feed('리스폰!');
      } else {
        this.ensureRemotePlayer(player).setTarget(player);
      }
    });
    socket.on('damaged', ({ hp }) => {
      this.hp = hp;
      this.updateHp();
      ui.damage.classList.add('flash');
      setTimeout(() => ui.damage.classList.remove('flash'), 80);
    });
    socket.on('playerKilled', ({ killer, victim }) => {
      this.playerStats.set(killer.id, killer);
      this.playerStats.set(victim.id, victim);
      this.feed(`${killer.name} → ${victim.name}`);
      this.updateScoreboard();
    });
    socket.on('shot', ({ shooterId, origin, end, hit }) => {
      this.renderTracer(origin, end, hit?.type === 'player');
      if (shooterId === this.myId) this.weapon.recoil();
    });
  }

  buildMap(map) {
    if (this.mapBuilt) return;
    this.mapBuilt = true;

    const floorGeo = new THREE.PlaneGeometry(map.worldSize, map.worldSize);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x06111e, roughness: 0.72, metalness: 0.18 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(map.worldSize, map.worldSize / 4, 0x21d4fd, 0x132236);
    grid.position.y = 0.01;
    this.scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x0a1424, emissive: 0x001726, roughness: 0.42, metalness: 0.48 });
    for (const obstacle of map.obstacles) {
      const geo = new THREE.BoxGeometry(obstacle.w, obstacle.h, obstacle.d);
      const mesh = new THREE.Mesh(geo, wallMat.clone());
      mesh.position.set(obstacle.x, obstacle.h / 2, obstacle.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x38e8ff }));
      mesh.add(edges);
      this.scene.add(mesh);
      this.obstacleBoxes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) });
    }

    this.addBoundary(map.worldSize);
  }

  addBoundary(size) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
    const wallGeo = new THREE.PlaneGeometry(size, 8);
    const half = size / 2;
    const walls = [
      [0, 4, -half, 0],
      [0, 4, half, Math.PI],
      [-half, 4, 0, Math.PI / 2],
      [half, 4, 0, -Math.PI / 2],
    ];
    for (const [x, y, z, rot] of walls) {
      const wall = new THREE.Mesh(wallGeo, mat);
      wall.position.set(x, y, z);
      wall.rotation.y = rot;
      this.scene.add(wall);
    }
  }

  applySnapshot(snapshot) {
    ui.players.textContent = String(snapshot.players.length);
    for (const player of snapshot.players) {
      this.playerStats.set(player.id, player);
      if (player.id === this.myId) {
        this.hp = player.hp;
        this.updateHp();
      } else {
        this.ensureRemotePlayer(player).setTarget(player);
      }
    }
    for (const id of [...this.remotePlayers.keys()]) {
      if (!snapshot.players.some((p) => p.id === id)) {
        const remote = this.remotePlayers.get(id);
        this.scene.remove(remote.group);
        remote.dispose();
        this.remotePlayers.delete(id);
      }
    }
    this.updateScoreboard();
  }

  ensureRemotePlayer(player) {
    if (!this.remotePlayers.has(player.id)) {
      const remote = new RemotePlayer(player);
      this.scene.add(remote.group);
      this.remotePlayers.set(player.id, remote);
    }
    return this.remotePlayers.get(player.id);
  }

  updateScoreboard() {
    const players = [...this.playerStats.values()].sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    const me = this.playerStats.get(this.myId);
    if (me) {
      ui.kills.textContent = String(me.score);
      ui.deaths.textContent = String(me.deaths);
    }
    ui.leaderboard.innerHTML = players
      .slice(0, 8)
      .map((p) => `<div class="lb-row ${p.id === this.myId ? 'me' : ''}"><span>${escapeHtml(p.name)}</span><b>${p.score}/${p.deaths}</b></div>`)
      .join('');
  }

  updateHp() {
    ui.hp.textContent = String(this.hp);
    ui.hp.style.color = this.hp <= 30 ? '#fb7185' : '#e6f7ff';
  }

  shoot() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    socket.emit('shoot', { dir: { x: dir.x, y: dir.y, z: dir.z } });
  }

  renderTracer(origin, end, isHit) {
    const start = new THREE.Vector3(origin.x, origin.y, origin.z);
    const finish = new THREE.Vector3(end.x, end.y, end.z);
    const geo = new THREE.BufferGeometry().setFromPoints([start, finish]);
    const mat = new THREE.LineBasicMaterial({ color: isHit ? 0xff3b7f : 0x6ee7ff, transparent: true, opacity: 1 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    let life = 1;
    const fade = () => {
      life -= 0.09;
      mat.opacity = Math.max(0, life);
      if (life <= 0) {
        this.scene.remove(line);
        geo.dispose();
        mat.dispose();
      } else requestAnimationFrame(fade);
    };
    fade();
  }

  feed(text) {
    const line = document.createElement('div');
    line.className = 'feed-line';
    line.textContent = text;
    ui.feed.prepend(line);
    setTimeout(() => line.remove(), 4200);
  }

  move(delta) {
    if (!this.controls.isLocked) return;

    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 10.5 : 7.2;
    const damping = Math.exp(-12 * delta);
    this.velocity.x *= damping;
    this.velocity.z *= damping;
    this.velocity.y -= 22 * delta;

    const forward = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    const strafe = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const wish = new THREE.Vector3(strafe, 0, -forward);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed * delta * 35);
    this.velocity.x += wish.x;
    this.velocity.z += wish.z;

    const before = this.controls.getObject().position.clone();
    this.controls.moveRight(this.velocity.x * delta);
    if (this.collides()) {
      this.controls.getObject().position.copy(before);
      this.velocity.x = 0;
    }
    const beforeZ = this.controls.getObject().position.clone();
    this.controls.moveForward(-this.velocity.z * delta);
    if (this.collides()) {
      this.controls.getObject().position.copy(beforeZ);
      this.velocity.z = 0;
    }

    const pos = this.controls.getObject().position;
    pos.y += this.velocity.y * delta;
    if (pos.y <= 1.8) {
      pos.y = 1.8;
      this.velocity.y = 0;
      this.canJump = true;
    }

    const half = (this.map?.worldSize || 92) / 2 - 1;
    pos.x = THREE.MathUtils.clamp(pos.x, -half, half);
    pos.z = THREE.MathUtils.clamp(pos.z, -half, half);

    const t = performance.now();
    if (t - this.lastSend > 45) {
      this.lastSend = t;
      socket.emit('move', { x: pos.x, y: pos.y, z: pos.z, yaw: this.camera.rotation.y, pitch: this.camera.rotation.x });
    }
  }

  collides() {
    const pos = this.controls.getObject().position;
    const playerBox = new THREE.Box3(
      new THREE.Vector3(pos.x - 0.45, 0.05, pos.z - 0.45),
      new THREE.Vector3(pos.x + 0.45, 2.5, pos.z + 0.45),
    );
    return this.obstacleBoxes.some(({ box }) => box.intersectsBox(playerBox));
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.move(delta);
    this.weapon.update(delta);
    for (const remote of this.remotePlayers.values()) remote.update(delta);
    this.renderer.render(this.scene, this.camera);
  }
}

class RemotePlayer {
  constructor(player) {
    this.group = new THREE.Group();
    this.target = new THREE.Vector3(player.x, player.y, player.z);

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.45, 1.05, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xff2f92, emissive: 0x210011, roughness: 0.35 }),
    );
    body.castShadow = true;
    this.group.add(body);

    const nameCanvas = document.createElement('canvas');
    nameCanvas.width = 256;
    nameCanvas.height = 64;
    const ctx = nameCanvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#8ff3ff';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(player.name, 128, 40);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(nameCanvas), transparent: true }));
    sprite.position.y = 1.55;
    sprite.scale.set(2.6, 0.65, 1);
    this.group.add(sprite);

    this.group.position.copy(this.target);
  }

  setTarget(player) {
    this.target.set(player.x, player.y, player.z);
    this.group.visible = player.alive;
  }

  update() {
    this.group.position.lerp(this.target, 0.24);
  }

  dispose() {
    this.group.traverse((obj) => {
      obj.geometry?.dispose?.();
      obj.material?.dispose?.();
    });
  }
}

class Weapon {
  constructor(camera) {
    this.group = new THREE.Group();
    this.base = new THREE.Vector3(0.36, -0.34, -0.58);
    this.kick = 0;

    const mat = new THREE.MeshStandardMaterial({ color: 0x07111f, metalness: 0.85, roughness: 0.25, emissive: 0x001726 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.72), mat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.5), mat);
    barrel.position.set(0, 0.03, -0.45);
    const glow = new THREE.PointLight(0x67e8f9, 0.8, 3);
    glow.position.set(0, 0, -0.75);
    this.group.add(body, barrel, glow);
    this.group.position.copy(this.base);
    camera.add(this.group);
  }

  recoil() {
    this.kick = 1;
  }

  update(delta) {
    this.kick = Math.max(0, this.kick - delta * 8);
    this.group.position.copy(this.base).add(new THREE.Vector3(0, -0.02 * this.kick, 0.09 * this.kick));
    this.group.rotation.x = -0.18 * this.kick;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

new NeonArena();
