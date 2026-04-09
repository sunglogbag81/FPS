import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

/**
 * FPS Game Engine - High End Version
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

        // 조명 (Volumetric 느낌)
        const hemiLight = new THREE.HemisphereLight(0x4433aa, 0x000000, 0.5);
        this.scene.add(hemiLight);

        const sun = new THREE.DirectionalLight(0x00ffff, 1);
        sun.position.set(50, 100, 50);
        sun.castShadow = true;
        this.scene.add(sun);

        // 맵 생성
        this.createEnvironment();
    }

    createEnvironment() {
        // 거대 바닥
        const floorGeo = new THREE.PlaneGeometry(1000, 1000);
        const floorMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.1, metalness: 0.5 });
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        this.scene.add(floor);

        // 사이버 그리드
        const grid = new THREE.GridHelper(1000, 100, 0x00ffff, 0x111111);
        this.scene.add(grid);

        // 장애물 (동적 생성)
        this.obstacles = [];
        for (let i = 0; i < 40; i++) {
            const h = Math.random() * 15 + 2;
            const geo = new THREE.BoxGeometry(5, h, 5);
            const mat = new THREE.MeshStandardMaterial({ color: 0x111111 });
            const box = new THREE.Mesh(geo, mat);
            box.position.set(Math.random() * 160 - 80, h/2, Math.random() * 160 - 80);
            box.castShadow = true;
            box.receiveShadow = true;
            
            // 네온 엣지
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
        this.moveStates = { f: false, b: false, l: false, r: false, jump: false };

        document.addEventListener('keydown', (e) => this.onKey(e.code, true));
        document.addEventListener('keyup', (e) => this.onKey(e.code, false));
        document.addEventListener('mousedown', (e) => this.onMouseDown(e));
    }

    onKey(code, isDown) {
        switch (code) {
            case 'KeyW': this.moveStates.f = isDown; break;
            case 'KeyS': this.moveStates.b = isDown; break;
            case 'KeyA': this.moveStates.l = isDown; break;
            case 'KeyD': this.moveStates.r = isDown; break;
            case 'Space': if (isDown && this.canJump) this.velocity.y += 30; this.canJump = false; break;
        }
    }

    initEntities() {
        this.players = {};
        // 무기 모델 (Procedural)
        this.weapon = new Weapon(this.camera);
        this.scene.add(this.weapon.group);
    }

    initNetwork() {
        this.socket = io();
        this.socket.on('init', (data) => {
            this.myId = data.id;
            Object.keys(data.players).forEach(id => {
                if (id !== this.myId) this.addRemotePlayer(id, data.players[id]);
            });
        });

        this.socket.on('playerJoined', (p) => this.addRemotePlayer(p.id, p));
        this.socket.on('playerMoved', (p) => {
            if (this.players[p.id]) this.players[p.id].targetPos.set(p.x, p.y, p.z);
        });
        this.socket.on('playerShot', (data) => this.weapon.renderTracer(data.muzzlePos, data.targetPos));
        this.socket.on('hpUpdate', (data) => {
            if (data.id === this.myId) this.updateHP(data.hp);
        });
        this.socket.on('respawn', (pos) => {
            this.controls.getObject().position.set(pos.x, pos.y, pos.z);
        });
        this.socket.on('playerLeft', (id) => {
            if (this.players[id]) {
                this.scene.remove(this.players[id].mesh);
                delete this.players[id];
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
        const intersects = raycaster.intersectObjects(targets);

        let endPoint = new THREE.Vector3();
        this.camera.getWorldDirection(endPoint).multiplyScalar(100).add(this.camera.position);

        if (intersects.length > 0) {
            const hit = intersects[0];
            endPoint.copy(hit.point);
            if (hit.object.parent && hit.object.parent.type !== "Scene") {
                // 상자 등을 쐈을 때
            }
            // 적 타격 판정
            for (let id in this.players) {
                if (this.players[id].mesh === hit.object) {
                    this.socket.emit('hit', id);
                    this.weapon.createImpact(hit.point, true);
                    break;
                }
            }
            if (!hit.object.userData.id) this.weapon.createImpact(hit.point, false);
        }

        this.weapon.fire();
        this.socket.emit('shoot', { muzzlePos: this.camera.position, targetPos: endPoint });
    }

    updateHP(hp) {
        document.getElementById('hp-fill').style.width = `${hp}%`;
    }

    initUI() {
        const ui = document.createElement('div');
        ui.innerHTML = `
            <div id="hud" style="position:fixed; bottom:20px; left:20px; width:250px; height:20px; border:2px solid #0ff; padding:2px;">
                <div id="hp-fill" style="width:100%; height:100%; background:#0ff; transition:0.2s;"></div>
            </div>
            <div id="kill-feed" style="position:fixed; top:20px; right:20px; color:#0ff; font-family:monospace; text-align:right;"></div>
        `;
        document.body.appendChild(ui);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        const time = performance.now();
        const delta = (time - this.lastTime) / 1000;

        if (this.controls.isLocked) {
            // 물리 로직
            this.velocity.x -= this.velocity.x * 10.0 * delta;
            this.velocity.z -= this.velocity.z * 10.0 * delta;
            this.velocity.y -= 9.8 * 100.0 * delta;

            this.direction.z = Number(this.moveStates.f) - Number(this.moveStates.b);
            this.direction.x = Number(this.moveStates.r) - Number(this.moveStates.l);
            this.direction.normalize();

            if (this.moveStates.f || this.moveStates.b) this.velocity.z -= this.direction.z * 400.0 * delta;
            if (this.moveStates.l || this.moveStates.r) this.velocity.x -= this.direction.x * 400.0 * delta;

            this.controls.moveRight(-this.velocity.x * delta);
            this.controls.moveForward(-this.velocity.z * delta);
            this.controls.getObject().position.y += (this.velocity.y * delta);

            if (this.controls.getObject().position.y < 2) {
                this.velocity.y = 0;
                this.controls.getObject().position.y = 2;
                this.canJump = true;
            }

            // 네트워크 전송
            const pos = this.controls.getObject().position;
            this.socket.emit('update', { x: pos.x, y: pos.y, z: pos.z, rx: this.camera.rotation.x, ry: this.camera.rotation.y });
        }

        // 원격 플레이어 보간 (Interpolation)
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
        // 반동
        this.group.position.z += 0.05;
        this.group.rotation.x -= 0.1;
        setTimeout(() => {
            this.group.position.z -= 0.05;
            this.group.rotation.x += 0.1;
        }, 50);
    }

    renderTracer(start, end) {
        // 총알 궤적 효과
        const points = [new THREE.Vector3().copy(start).add(new THREE.Vector3(0,-0.5,0)), end];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 1 });
        const line = new THREE.Line(geo, mat);
        this.camera.parent.add(line); // Scene에 추가

        const fade = setInterval(() => {
            mat.opacity -= 0.1;
            if (mat.opacity <= 0) {
                clearInterval(fade);
                this.camera.parent.remove(line);
            }
        }, 30);
    }

    createImpact(pos, isPlayer) {
        const geo = new THREE.SphereGeometry(isPlayer ? 0.3 : 0.1, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color: isPlayer ? 0xff0000 : 0xffff00 });
        const p = new THREE.Mesh(geo, mat);
        p.position.copy(pos);
        this.camera.parent.add(p);
        setTimeout(() => this.camera.parent.remove(p), 200);
    }
}

new GameEngine();