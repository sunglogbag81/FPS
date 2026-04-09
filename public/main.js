import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

/**
 * FPS Game Engine - Bug Fixed & Updated
 */
class GameEngine {
    constructor() {
        this.initScene();
        this.initPhysics();
        this.initEntities();
        this.initNetwork();
        this.initUI();

        this.lastTime = performance.now();
        this.animate();
    }

    initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x020205);
        this.scene.fog = new THREE.FogExp2(0x020205, 0.015);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        document.body.appendChild(this.renderer.domElement);

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        const hemiLight = new THREE.HemisphereLight(0x4433aa, 0x000000, 0.5);
        this.scene.add(hemiLight);

        const sun = new THREE.DirectionalLight(0x00ffff, 1);
        sun.position.set(50, 100, 50);
        sun.castShadow = true;
        this.scene.add(sun);

        this.createEnvironment();
    }

    createEnvironment() {
        const floorGeo = new THREE.PlaneGeometry(1000, 1000);
        const floorMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.1, metalness: 0.5 });
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        this.scene.add(floor);

        const grid = new THREE.GridHelper(1000, 100, 0x00ffff, 0x111111);
        this.scene.add(grid);

        this.obstacles = [];
        for (let i = 0; i < 40; i++) {
            const h = Math.random() * 15 + 2;
            const geo = new THREE.BoxGeometry(5, h, 5);
            const mat = new THREE.MeshStandardMaterial({ color: 0x111111 });
            const box = new THREE.Mesh(geo, mat);
            box.position.set(Math.random() * 160 - 80, h / 2, Math.random() * 160 - 80);
            box.castShadow = true;
            box.receiveShadow = true;

            const edges = new THREE.EdgesGeometry(geo);
            const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x00ffff }));
            box.add(line);

            this.scene.add(box);
            this.obstacles.push(box);
        }
    }

    initPhysics() {
        this.controls = new PointerLockControls(this.camera, document.body);
        this.velocity = new THREE.Vector3();
        this.direction = new THREE.Vector3();
        this.moveStates = { f: false, b: false, l: false, r: false };
        this.canJump = false;

        document.addEventListener('keydown', (e) => this.onKey(e.code, true));
        document.addEventListener('keyup', (e) => this.onKey(e.code, false));
        document.addEventListener('mousedown', (e) => this.onMouseDown(e));

        // PointerLock 해제 시 blocker 표시
        this.controls.addEventListener('unlock', () => {
            document.getElementById('blocker').style.display = 'flex';
        });
        this.controls.addEventListener('lock', () => {
            document.getElementById('blocker').style.display = 'none';
        });
    }

    onKey(code, isDown) {
        switch (code) {
            case 'KeyW': this.moveStates.f = isDown; break;
            case 'KeyS': this.moveStates.b = isDown; break;
            case 'KeyA': this.moveStates.l = isDown; break;
            case 'KeyD': this.moveStates.r = isDown; break;
            case 'Space':
                // [BUG FIX] keyup 시에도 Space 처리 방지
                if (isDown && this.canJump) {
                    this.velocity.y += 15;
                    this.canJump = false;
                }
                break;
        }
    }

    initEntities() {
        this.players = {};
        this.myId = null;
        this.myHp = 100;
        this.weapon = new Weapon(this.camera);
        this.scene.add(this.weapon.group);
    }

    initNetwork() {
        this.socket = io();

        // [BUG FIX] 'init' 이벤트로 통일 (서버와 일치)
        this.socket.on('init', (data) => {
            this.myId = data.id;
            Object.keys(data.players).forEach(id => {
                if (id !== this.myId) this.addRemotePlayer(id, data.players[id]);
            });
        });

        // [BUG FIX] 'playerJoined' 이벤트로 통일
        this.socket.on('playerJoined', (p) => this.addRemotePlayer(p.id, p));

        this.socket.on('playerMoved', (p) => {
            if (this.players[p.id]) {
                this.players[p.id].targetPos.set(p.x, p.y, p.z);
            }
        });

        this.socket.on('playerShot', (data) => {
            // [BUG FIX] muzzlePos/targetPos가 plain object이므로 Vector3 변환
            const start = new THREE.Vector3(data.muzzlePos.x, data.muzzlePos.y, data.muzzlePos.z);
            const end = new THREE.Vector3(data.targetPos.x, data.targetPos.y, data.targetPos.z);
            this.weapon.renderTracer(this.scene, start, end);
        });

        // [BUG FIX] hpUpdate가 {id, hp} 객체로 오도록 수정
        this.socket.on('hpUpdate', (data) => {
            if (data.id === this.myId) {
                this.myHp = data.hp;
                this.updateHPUI(data.hp);
            }
        });

        this.socket.on('respawn', (pos) => {
            this.controls.getObject().position.set(pos.x, pos.y, pos.z);
            this.velocity.set(0, 0, 0);
            this.myHp = 100;
            this.updateHPUI(100);
        });

        // [BUG FIX] 'playerLeft' 이벤트로 통일
        this.socket.on('playerLeft', (id) => {
            if (this.players[id]) {
                this.scene.remove(this.players[id].mesh);
                delete this.players[id];
                this.addKillFeed(`플레이어 [${id.slice(0,6)}] 퇴장`);
            }
        });
    }

    addRemotePlayer(id, data) {
        const mesh = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.8, 1.5, 4, 16),
            new THREE.MeshStandardMaterial({ color: 0xff0055, emissive: 0x220000 })
        );
        mesh.position.set(data.x, data.y, data.z);
        this.scene.add(mesh);
        this.players[id] = { mesh, targetPos: new THREE.Vector3(data.x, data.y, data.z) };
    }

    onMouseDown(e) {
        if (!this.controls.isLocked) {
            this.controls.lock();
            return;
        }
        if (e.button === 0) this.shoot();
    }

    shoot() {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);

        const targets = [...this.obstacles, ...Object.values(this.players).map(p => p.mesh)];
        const intersects = raycaster.intersectObjects(targets, true);

        let endPoint = new THREE.Vector3();
        this.camera.getWorldDirection(endPoint);
        endPoint.multiplyScalar(100).add(this.camera.position);

        let hitPlayer = false;
        if (intersects.length > 0) {
            const hit = intersects[0];
            endPoint.copy(hit.point);

            for (let id in this.players) {
                // [BUG FIX] CapsuleGeometry는 자식 mesh일 수 있으므로 traversal로 체크
                let isHit = false;
                this.players[id].mesh.traverse((obj) => {
                    if (obj === hit.object) isHit = true;
                });
                if (isHit) {
                    this.socket.emit('hit', id);
                    this.weapon.createImpact(this.scene, hit.point, true);
                    hitPlayer = true;
                    this.addKillFeed(`🎯 HIT!`);
                    break;
                }
            }
            if (!hitPlayer) this.weapon.createImpact(this.scene, hit.point, false);
        }

        this.weapon.fire();
        // [BUG FIX] shoot 이벤트 emit — 서버가 이제 수신함
        this.socket.emit('shoot', {
            muzzlePos: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
            targetPos: { x: endPoint.x, y: endPoint.y, z: endPoint.z }
        });
    }

    updateHPUI(hp) {
        const hpEl = document.getElementById('hp-ui');
        if (hpEl) hpEl.textContent = `HP: ${hp}`;
        // 체력이 낮으면 빨간색
        if (hp <= 30) {
            hpEl.style.color = '#f00';
            hpEl.style.textShadow = '0 0 8px #f00';
        } else {
            hpEl.style.color = '#0ff';
            hpEl.style.textShadow = '0 0 8px #0ff';
        }
    }

    addKillFeed(msg) {
        const feed = document.getElementById('kill-feed');
        if (!feed) return;
        const line = document.createElement('div');
        line.textContent = msg;
        line.style.opacity = '1';
        line.style.transition = 'opacity 2s';
        feed.prepend(line);
        setTimeout(() => { line.style.opacity = '0'; }, 2000);
        setTimeout(() => { if (feed.contains(line)) feed.removeChild(line); }, 4000);
    }

    initUI() {
        // kill-feed 컨테이너
        const kf = document.createElement('div');
        kf.id = 'kill-feed';
        kf.style.cssText = 'position:fixed;top:20px;right:20px;color:#0ff;font-family:monospace;text-align:right;pointer-events:none;';
        document.body.appendChild(kf);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        const time = performance.now();
        const delta = Math.min((time - this.lastTime) / 1000, 0.05); // delta 최대 50ms 클램프

        if (this.controls.isLocked) {
            // [BUG FIX] 중력값 9.8 * 10 (기존 9.8*100은 너무 강함)
            this.velocity.x -= this.velocity.x * 10.0 * delta;
            this.velocity.z -= this.velocity.z * 10.0 * delta;
            this.velocity.y -= 9.8 * 10.0 * delta;

            this.direction.z = Number(this.moveStates.f) - Number(this.moveStates.b);
            this.direction.x = Number(this.moveStates.r) - Number(this.moveStates.l);
            this.direction.normalize();

            if (this.moveStates.f || this.moveStates.b) this.velocity.z -= this.direction.z * 400.0 * delta;
            if (this.moveStates.l || this.moveStates.r) this.velocity.x -= this.direction.x * 400.0 * delta;

            this.controls.moveRight(-this.velocity.x * delta);
            this.controls.moveForward(-this.velocity.z * delta);
            this.controls.getObject().position.y += this.velocity.y * delta;

            if (this.controls.getObject().position.y < 2) {
                this.velocity.y = 0;
                this.controls.getObject().position.y = 2;
                this.canJump = true;
            }

            const pos = this.controls.getObject().position;
            this.socket.emit('update', {
                x: pos.x,
                y: pos.y,
                z: pos.z,
                rx: this.camera.rotation.x,
                ry: this.camera.rotation.y
            });
        }

        Object.values(this.players).forEach(p => {
            p.mesh.position.lerp(p.targetPos, 0.2);
        });

        this.renderer.render(this.scene, this.camera);
        this.lastTime = time;
    }
}

class Weapon {
    constructor(camera) {
        this.camera = camera;
        this.group = new THREE.Group();
        this.createModel();
    }

    createModel() {
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.15, 0.2, 0.7),
            new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.9 })
        );
        this.group.add(body);
        this.group.position.set(0.4, -0.4, -0.6);
        this.camera.add(this.group);
    }

    fire() {
        this.group.position.z += 0.05;
        this.group.rotation.x -= 0.1;
        setTimeout(() => {
            this.group.position.z -= 0.05;
            this.group.rotation.x += 0.1;
        }, 50);
    }

    // [BUG FIX] scene을 인자로 받아 안전하게 추가
    renderTracer(scene, start, end) {
        const points = [start.clone(), new THREE.Vector3(end.x, end.y, end.z)];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 1 });
        const line = new THREE.Line(geo, mat);
        scene.add(line);

        const fade = setInterval(() => {
            mat.opacity -= 0.1;
            if (mat.opacity <= 0) {
                clearInterval(fade);
                scene.remove(line);
                geo.dispose();
                mat.dispose();
            }
        }, 30);
    }

    // [BUG FIX] scene을 인자로 받아 안전하게 추가
    createImpact(scene, pos, isPlayer) {
        const geo = new THREE.SphereGeometry(isPlayer ? 0.3 : 0.1, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color: isPlayer ? 0xff0000 : 0xffff00 });
        const p = new THREE.Mesh(geo, mat);
        p.position.copy(pos);
        scene.add(p);
        setTimeout(() => {
            scene.remove(p);
            geo.dispose();
            mat.dispose();
        }, 200);
    }
}

new GameEngine();
