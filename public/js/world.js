// Scene kantor isometrik: ruangan, furnitur, lampu, tema, dan grid navigasi.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const ROOM = { minX: -11, maxX: 11, minZ: -6.5, maxZ: 6.5, wallH: 3.2 };

const PALETTE = {
  wood: '#5a3a26',
  woodLight: '#8a5a3a',
  metal: '#1f2430',
  chair: '#2a2f3a',
  wall: '#6b6f7e',
  trim: '#4a4d59',
  sofa: '#a8a29e',
  rug: '#d6d3c9',
  plant: '#2f855a',
  pot: '#c9c3b6',
  glass: '#9fd3ff',
  lamp: '#fff1c1',
};

const mats = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!mats.has(key)) mats.set(key, new THREE.MeshLambertMaterial({ color, ...opts }));
  return mats.get(key);
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class World {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.obstacles = []; // [x1, z1, x2, z2]
    this.spots = { desks: [], meeting: [], coffee: [], lounge: [] };
    this.animated = []; // fn(dt, t)
    this.themeHooks = []; // fn(isDark)

    this.#setupRenderer();
    this.#setupCamera();
    this.#setupLights();
    this.#buildRoom();
  }

  // ---------- setup ----------

  #setupRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(r.domElement);

    const lr = (this.labelRenderer = new CSS2DRenderer());
    lr.domElement.className = 'labels';
    this.container.appendChild(lr.domElement);

    window.addEventListener('resize', () => this.resize());
  }

  #setupCamera() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.labelRenderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      screenSpacePanning: true,
      minZoom: 0.6,
      maxZoom: 3.5,
      minPolarAngle: 0.45,
      maxPolarAngle: 1.2,
      minAzimuthAngle: -0.25,
      maxAzimuthAngle: 1.5,
    });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.resetCamera();
    this.resize();
  }

  resetCamera() {
    this.controls.target.set(0.5, 0, 0.5);
    this.camera.position.set(20.5, 22, 26.5);
    this.camera.zoom = window.innerWidth < 700 ? 0.8 : 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const viewH = 17;
    const aspect = w / h;
    Object.assign(this.camera, { left: (-viewH * aspect) / 2, right: (viewH * aspect) / 2, top: viewH / 2, bottom: -viewH / 2 });
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  #setupLights() {
    this.hemi = new THREE.HemisphereLight('#ffffff', '#6b5a4a', 1.4);
    this.scene.add(this.hemi);

    const sun = (this.sun = new THREE.DirectionalLight('#ffffff', 2.2));
    sun.position.set(8, 16, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 12, bottom: -12, near: 1, far: 50 });
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);

    // Lampu hangat, hanya menyala di mode gelap.
    this.warmLights = [
      [-5.5, 2.6, -1.2],
      [-5.5, 2.6, 2.8],
      [7.5, 2.6, -3.7],
      [7.5, 2.6, 3.5],
      [1.8, 2.4, -5],
    ].map(([x, y, z]) => {
      const l = new THREE.PointLight('#ffc98a', 0, 9, 1.4);
      l.position.set(x, y, z);
      this.scene.add(l);
      return l;
    });
  }

  setTheme(isDark) {
    this.isDark = isDark;
    this.scene.background = new THREE.Color(isDark ? '#141b2d' : '#dfe8f3');
    this.hemi.intensity = isDark ? 0.55 : 1.5;
    this.hemi.color.set(isDark ? '#9fb3ff' : '#ffffff');
    this.sun.intensity = isDark ? 0.5 : 2.2;
    this.sun.color.set(isDark ? '#9db4ff' : '#fff6e5');
    for (const l of this.warmLights) l.intensity = isDark ? 14 : 0;
    for (const fn of this.themeHooks) fn(isDark);
  }

  // ---------- helpers ----------

  box(w, h, d, color, x, y, z, { shadow = true, parent = this.scene, material } = {}) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material || mat(color));
    m.position.set(x, y + h / 2, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  cyl(rTop, rBot, h, color, x, y, z, { seg = 12, parent = this.scene, material } = {}) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), material || mat(color));
    m.position.set(x, y + h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  block(x1, z1, x2, z2) {
    this.obstacles.push([Math.min(x1, x2), Math.min(z1, z2), Math.max(x1, x2), Math.max(z1, z2)]);
  }

  label(text, x, y, z, cls = 'zone') {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    const obj = new CSS2DObject(el);
    obj.position.set(x, y, z);
    this.scene.add(obj);
    return obj;
  }

  // ---------- ruangan ----------

  #buildRoom() {
    const { minX, maxX, minZ, maxZ, wallH } = ROOM;
    const W = maxX - minX;
    const D = maxZ - minZ;

    // Lantai kayu. Pola dibuat dengan random ber-seed dan digambar melingkar
    // (wrap) supaya tile-nya menyambung mulus tanpa papan gelap/terpotong.
    const floorTex = canvasTexture(512, 512, (g, w, h) => {
      let seed = 1234;
      const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      const rows = 8;
      const rh = h / rows;
      g.fillStyle = 'rgb(132,86,55)';
      g.fillRect(0, 0, w, h);
      for (let r = 0; r < rows; r++) {
        let x = Math.floor(rand() * 200);
        const end = x + w;
        while (x < end) {
          const len = Math.min(170 + Math.floor(rand() * 110), end - x);
          const shade = 0.9 + rand() * 0.16; // selalu dalam rentang terang yang sama
          g.fillStyle = `rgb(${Math.round(148 * shade)},${Math.round(97 * shade)},${Math.round(62 * shade)})`;
          for (const off of [0, -w]) {
            g.fillRect(x + off, r * rh, len, rh);
            g.fillStyle = 'rgba(60,35,20,0.35)';
            g.fillRect(x + off, r * rh, 2, rh);
            g.fillStyle = `rgb(${Math.round(148 * shade)},${Math.round(97 * shade)},${Math.round(62 * shade)})`;
          }
          x += len;
        }
        g.fillStyle = 'rgba(60,35,20,0.35)';
        g.fillRect(0, r * rh, w, 2);
      }
    });
    floorTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(W / 4, D / 4);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshLambertMaterial({ map: floorTex }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.floor = floor;

    // Pinggiran lantai (tebal) biar terlihat seperti diorama. Sisi atasnya sedikit di bawah
    // lantai supaya tidak berebut kedalaman dengan lantai (penyebab kedap-kedip / z-fighting).
    this.box(W + 0.4, 0.3, D + 0.4, '#2a2f3d', (minX + maxX) / 2, -0.32, (minZ + maxZ) / 2, { shadow: false });

    // Dinding belakang & kiri
    this.box(W + 0.2, wallH, 0.2, PALETTE.wall, (minX + maxX) / 2, 0, minZ - 0.1);
    this.box(0.2, wallH, D, PALETTE.wall, minX - 0.1, 0, (minZ + maxZ) / 2);
    this.box(W + 0.2, 0.12, 0.3, PALETTE.trim, (minX + maxX) / 2, wallH, minZ - 0.1);
    this.box(0.3, 0.12, D, PALETTE.trim, minX - 0.1, wallH, (minZ + maxZ) / 2);
    this.box(W, 0.12, 0.04, PALETTE.trim, (minX + maxX) / 2, 0, minZ + 0.02, { shadow: false });
    this.box(0.04, 0.12, D, PALETTE.trim, minX + 0.02, 0, (minZ + maxZ) / 2, { shadow: false });
    this.block(minX - 1, minZ - 1, maxX + 1, minZ + 0.05);
    this.block(minX - 1, minZ - 1, minX + 0.05, maxZ + 1);

    // Jendela
    this.#window('back', -9.4, 2.2);
    this.#window('back', -1.4, 2);
    this.#window('back', 2.2, 2.2);
    this.#window('left', -3.8, 2.4);
    this.#window('left', 0.4, 2.4);
    this.#window('left', 4.4, 2.4);

    this.#kanban(-5.4, 1.1);
    this.#clock(0.35, 2.55);
    this.#shelf(-10.5, -5.2);

    this.#desks();
    this.#meetingRoom();
    this.#coffeeCorner(1.85);
    this.#lounge();

    for (const [x, z, s] of [[-10.4, 5.9, 1], [-0.1, -5.95, 0.9], [10.4, 0.4, 1.1], [-10.4, -2.1, 0.8], [3.9, 5.9, 0.9]]) this.#plant(x, z, s);
  }

  #window(wall, pos, width) {
    const h = 1.6;
    const y = 1.0;
    const makeTex = (dark) =>
      canvasTexture(256, 180, (g, w, hh) => {
        const sky = g.createLinearGradient(0, 0, 0, hh);
        sky.addColorStop(0, dark ? '#0b1430' : '#8cc8f5');
        sky.addColorStop(1, dark ? '#1c2c5c' : '#d9efff');
        g.fillStyle = sky;
        g.fillRect(0, 0, w, hh);
        let seed = Math.round(pos * 100 + 7);
        const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
        for (let x = 0; x < w; ) {
          const bw = 18 + rand() * 30;
          const bh = 50 + rand() * 110;
          g.fillStyle = dark ? '#0e1630' : '#a9bfd4';
          g.fillRect(x, hh - bh, bw, bh);
          for (let wy = hh - bh + 6; wy < hh - 4; wy += 7) {
            for (let wx = x + 3; wx < x + bw - 3; wx += 6) {
              if (rand() < (dark ? 0.45 : 0.3)) {
                g.fillStyle = dark ? (rand() < 0.8 ? '#ffd98a' : '#9ed0ff') : '#e7f1fb';
                g.fillRect(wx, wy, 3, 3);
              }
            }
          }
          x += bw + 2;
        }
      });
    const tex = { dark: makeTex(true), light: makeTex(false) };
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, h), new THREE.MeshBasicMaterial({ map: tex.dark }));
    const group = new THREE.Group();
    group.add(pane);
    const frame = mat('#e5e7eb');
    const bar = (w, hh, x, yy) => this.box(w, hh, 0.08, null, x, yy - hh / 2, 0.02, { parent: group, material: frame, shadow: false });
    bar(width + 0.12, 0.08, 0, h / 2 + 0.04);
    bar(width + 0.12, 0.08, 0, -h / 2 - 0.04);
    bar(0.08, h, -width / 2 - 0.02, 0);
    bar(0.08, h, width / 2 + 0.02, 0);
    bar(0.05, h, 0, 0);
    bar(width, 0.05, 0, 0);
    this.box(width + 0.3, 0.06, 0.2, '#d1d5db', 0, -h / 2 - 0.12, 0.08, { parent: group, shadow: false });
    if (wall === 'back') group.position.set(pos, y + h / 2, ROOM.minZ + 0.02);
    else {
      group.position.set(ROOM.minX + 0.02, y + h / 2, pos);
      group.rotation.y = Math.PI / 2;
    }
    this.scene.add(group);
    this.themeHooks.push((dark) => (pane.material.map = dark ? tex.dark : tex.light));
  }

  #kanban(x, y) {
    const w = 3.6;
    const h = 1.6;
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 455;
    this.kanbanCanvas = c;
    this.kanbanTex = new THREE.CanvasTexture(c);
    this.kanbanTex.colorSpace = THREE.SRGBColorSpace;
    this.kanbanTex.anisotropy = 4;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.kanbanTex }));
    board.position.set(x, y + h / 2, ROOM.minZ + 0.04);
    this.scene.add(board);
    this.kanbanMesh = board;
    this.box(w + 0.12, h + 0.12, 0.05, '#e5e7eb', x, y - 0.06, ROOM.minZ + 0.01, { shadow: false });
    const el = document.createElement('div');
    el.className = 'zone clickable';
    el.textContent = '📋 Kanban';
    const label = new CSS2DObject(el);
    label.position.set(x, y + h + 0.05, ROOM.minZ + 0.1);
    this.scene.add(label);
    this.kanbanLabel = el;
    this.setKanban([]);
  }

  // Gambar ulang papan kanban di dinding. colorOf(agentId) → warna kartu.
  setKanban(tasks, colorOf = () => '#94a3b8') {
    const c = this.kanbanCanvas;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    g.fillStyle = '#f8fafc';
    g.fillRect(0, 0, W, H);
    const cols = [
      ['TODO', (t) => t.status === 'todo', '#64748b'],
      ['PROSES', (t) => t.status === 'proses', '#3b82f6'],
      ['REVIEW', (t) => t.status === 'review', '#f59e0b'],
      ['SELESAI', (t) => t.status === 'selesai' || t.status === 'gagal', '#10b981'],
    ];
    const colW = W / 4;
    const open = tasks.filter((t) => ['todo', 'proses', 'review'].includes(t.status)).length;
    this.kanbanLabel.textContent = `📋 Kanban · ${open} terbuka`;
    cols.forEach(([name, filter, color], i) => {
      const x0 = i * colW;
      const list = tasks.filter(filter).sort((a, b) => b.updatedAt - a.updatedAt);
      g.fillStyle = i % 2 ? '#f1f5f9' : '#f8fafc';
      g.fillRect(x0, 0, colW, H);
      g.fillStyle = color;
      g.fillRect(x0 + 12, 14, colW - 24, 6);
      g.fillStyle = '#0f172a';
      g.font = 'bold 26px sans-serif';
      g.fillText(`${name}`, x0 + 14, 52);
      g.fillStyle = '#64748b';
      g.font = '22px sans-serif';
      g.fillText(String(list.length), x0 + colW - 40, 52);
      const cardH = 62;
      const max = 5;
      list.slice(0, max).forEach((t, k) => {
        const y = 70 + k * (cardH + 10);
        g.fillStyle = '#ffffff';
        g.fillRect(x0 + 12, y, colW - 24, cardH);
        g.fillStyle = t.status === 'gagal' ? '#ef4444' : colorOf(t.assignee);
        g.fillRect(x0 + 12, y, 10, cardH);
        g.strokeStyle = '#e2e8f0';
        g.lineWidth = 2;
        g.strokeRect(x0 + 12, y, colW - 24, cardH);
        g.fillStyle = '#0f172a';
        g.font = 'bold 19px sans-serif';
        g.fillText(fit(g, `#${t.id} ${t.title}`, colW - 50), x0 + 30, y + 26);
        g.fillStyle = '#64748b';
        g.font = '17px sans-serif';
        const sub = t.status === 'gagal' ? 'gagal' : t.waiting ? 'menunggu subtugas' : t.assignee || 'belum ditugaskan';
        g.fillText(fit(g, sub, colW - 50), x0 + 30, y + 50);
      });
      if (list.length > max) {
        g.fillStyle = '#64748b';
        g.font = '18px sans-serif';
        g.fillText(`+${list.length - max} lagi`, x0 + 16, 70 + max * (cardH + 10) + 16);
      }
    });
    this.kanbanTex.needsUpdate = true;
  }

  #clock(x, y) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const draw = () => {
      const g = c.getContext('2d');
      const now = new Date();
      g.clearRect(0, 0, 128, 128);
      g.fillStyle = '#f8fafc';
      g.beginPath();
      g.arc(64, 64, 60, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = '#1f2937';
      g.stroke();
      g.lineCap = 'round';
      const hand = (angle, len, width) => {
        g.lineWidth = width;
        g.beginPath();
        g.moveTo(64, 64);
        g.lineTo(64 + Math.sin(angle) * len, 64 - Math.cos(angle) * len);
        g.stroke();
      };
      const m = now.getMinutes();
      hand(((now.getHours() % 12) + m / 60) * (Math.PI / 6), 30, 6);
      hand(m * (Math.PI / 30), 46, 4);
      tex.needsUpdate = true;
    };
    draw();
    setInterval(draw, 30_000);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.38, 32), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    face.position.set(x, y, ROOM.minZ + 0.05);
    this.scene.add(face);
  }

  #shelf(x, z) {
    const g = new THREE.Group();
    this.box(0.9, 2.2, 0.08, '#b8a07e', 0, 0, -0.3, { parent: g });
    for (const sx of [-0.45, 0.45]) this.box(0.06, 2.2, 0.6, '#b8a07e', sx, 0, 0, { parent: g });
    for (let i = 0; i < 5; i++) this.box(0.9, 0.05, 0.6, '#c9b08a', 0, i * 0.52 + 0.05, 0, { parent: g });
    const bookColors = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6'];
    for (let i = 1; i < 4; i++) for (let b = 0; b < 5; b++) this.box(0.1, 0.3 + (b % 2) * 0.06, 0.4, bookColors[(b + i) % 5], -0.3 + b * 0.13, i * 0.52 + 0.1, 0, { parent: g });
    g.position.set(x, 0, z + 0.3);
    g.rotation.y = Math.PI / 2;
    this.scene.add(g);
    this.block(x - 0.35, z - 0.2, x + 0.35, z + 0.8);
  }

  #plant(x, z, s = 1) {
    this.cyl(0.22 * s, 0.17 * s, 0.4 * s, PALETTE.pot, x, 0, z);
    const leafMat = mat(PALETTE.plant);
    for (let i = 0; i < 6; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.08 * s, 0.9 * s, 4), leafMat);
      const a = (i / 6) * Math.PI * 2;
      leaf.position.set(x + Math.cos(a) * 0.08 * s, 0.75 * s, z + Math.sin(a) * 0.08 * s);
      leaf.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
      leaf.castShadow = true;
      this.scene.add(leaf);
    }
    this.block(x - 0.3, z - 0.3, x + 0.3, z + 0.3);
  }

  chair(x, z, rotY, color = PALETTE.chair) {
    const g = new THREE.Group();
    this.box(0.5, 0.08, 0.5, color, 0, 0.45, 0, { parent: g });
    this.box(0.5, 0.6, 0.08, color, 0, 0.53, 0.24, { parent: g });
    this.cyl(0.03, 0.03, 0.4, PALETTE.metal, 0, 0.05, 0, { seg: 6, parent: g });
    for (let i = 0; i < 5; i++) {
      const leg = this.box(0.3, 0.04, 0.05, PALETTE.metal, 0, 0.03, 0, { parent: g, shadow: false });
      leg.rotation.y = (i / 5) * Math.PI * 2;
      leg.translateX(0.15);
    }
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    this.scene.add(g);
    return g;
  }

  // ---------- meja kerja ----------

  #desks() {
    const cols = [-8.6, -5.5, -2.4];
    const rows = [-3.9, 0.1, 4.1];
    for (const z of rows) {
      for (const x of cols) {
        const g = new THREE.Group();
        this.box(1.7, 0.06, 0.8, PALETTE.wood, 0, 0.72, 0, { parent: g });
        this.box(0.06, 0.72, 0.74, PALETTE.wood, -0.8, 0, 0, { parent: g });
        this.box(0.06, 0.72, 0.74, PALETTE.wood, 0.8, 0, 0, { parent: g });
        this.box(1.6, 0.4, 0.04, PALETTE.wood, 0, 0.32, -0.35, { parent: g });
        // monitor
        this.box(0.08, 0.25, 0.08, PALETTE.metal, 0.1, 0.78, -0.2, { parent: g });
        this.box(0.7, 0.44, 0.05, PALETTE.metal, 0.1, 0.98, -0.22, { parent: g });
        const screenMat = new THREE.MeshBasicMaterial({ color: '#1e293b' });
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.38), screenMat);
        screen.position.set(0.1, 1.2, -0.19);
        g.add(screen);
        this.box(0.5, 0.02, 0.16, '#374151', 0.1, 0.78, 0.1, { parent: g, shadow: false });
        this.box(0.08, 0.02, 0.12, '#374151', 0.5, 0.78, 0.12, { parent: g, shadow: false });
        // lampu meja
        this.cyl(0.08, 0.1, 0.03, PALETTE.metal, -0.62, 0.78, -0.18, { parent: g });
        this.cyl(0.015, 0.015, 0.35, PALETTE.metal, -0.62, 0.8, -0.18, { seg: 6, parent: g });
        const shade = this.cyl(0.08, 0.15, 0.2, null, -0.62, 1.12, -0.18, { parent: g, material: new THREE.MeshLambertMaterial({ color: PALETTE.lamp, emissive: '#000000' }) });
        this.themeHooks.push((dark) => shade.material.emissive.set(dark ? '#ffcf7a' : '#000000'));
        // mug
        this.cyl(0.04, 0.04, 0.09, ['#ef4444', '#22c55e', '#6366f1'][Math.abs(x * z) % 3 | 0], -0.3, 0.78, 0.15, { seg: 8, parent: g });
        g.position.set(x, 0, z);
        this.scene.add(g);
        const chair = this.chair(x + 0.1, z + 0.75, 0);
        chair.visible = false;
        this.block(x - 0.88, z - 0.44, x + 0.88, z + 0.44);
        this.spots.desks.push({ group: g, chair, screenMat, x: x + 0.1, z: z + 0.78, rotY: Math.PI, pose: 'sit' });
      }
    }
    // Hanya meja yang dipakai yang ditampilkan (diatur lewat useDesks)
    for (const d of this.spots.desks) d.group.visible = false;
  }

  // Tampilkan n meja pertama, sembunyikan sisanya (dan buka blokirnya).
  useDesks(n) {
    const used = this.spots.desks.slice(0, n);
    const unused = this.spots.desks.slice(n);
    for (const d of used) d.group.visible = d.chair.visible = true;
    for (const d of unused) {
      d.group.visible = d.chair.visible = false;
      const x = d.group.position.x;
      const z = d.group.position.z;
      this.obstacles = this.obstacles.filter((o) => !(o[0] === x - 0.88 && o[1] === z - 0.44));
    }
    return used;
  }

  // ---------- ruang rapat ----------

  #meetingRoom() {
    const x0 = 4.2;
    const z1 = -0.6;
    const { maxX, minZ } = ROOM;
    const glassMat = new THREE.MeshLambertMaterial({ color: PALETTE.glass, transparent: true, opacity: 0.14, depthWrite: false });
    const frame = mat('#111827');
    const glassWall = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az);
      const g = new THREE.Group();
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(len, 2.4), glassMat);
      pane.position.y = 1.2;
      g.add(pane);
      this.box(len, 0.06, 0.06, null, 0, 2.4, 0, { parent: g, material: frame });
      this.box(len, 0.06, 0.06, null, 0, 0, 0, { parent: g, material: frame, shadow: false });
      this.box(0.06, 2.46, 0.06, null, -len / 2, 0, 0, { parent: g, material: frame });
      this.box(0.06, 2.46, 0.06, null, len / 2, 0, 0, { parent: g, material: frame });
      g.position.set((ax + bx) / 2, 0, (az + bz) / 2);
      g.rotation.y = -Math.atan2(bz - az, bx - ax);
      this.scene.add(g);
      this.block(Math.min(ax, bx) - 0.05, Math.min(az, bz) - 0.05, Math.max(ax, bx) + 0.05, Math.max(az, bz) + 0.05);
    };
    glassWall(x0, minZ, x0, z1);
    const doorA = x0 + 0.1;
    const doorB = x0 + 1.4;
    glassWall(doorB, z1, maxX, z1);
    // tiang kusen pintu
    this.box(0.06, 2.46, 0.06, null, doorA - 0.1, 0, z1, { material: frame });

    // karpet
    this.box(6.2, 0.02, 5.2, PALETTE.rug, 7.7, 0, -3.5, { shadow: false });

    // meja panjang
    const tx = 7.9;
    const tz = -3.55;
    this.box(4.2, 0.08, 1.4, '#3b2a20', tx, 0.72, tz);
    this.box(0.5, 0.72, 0.5, PALETTE.metal, tx - 1.3, 0, tz);
    this.box(0.5, 0.72, 0.5, PALETTE.metal, tx + 1.3, 0, tz);
    this.block(tx - 2.1, tz - 0.7, tx + 2.1, tz + 0.7);

    const seats = [];
    for (const dx of [-1.4, 0, 1.4]) {
      seats.push({ x: tx + dx, z: tz + 1.05, rotY: Math.PI, pose: 'sit' });
      seats.push({ x: tx + dx, z: tz - 1.05, rotY: 0, pose: 'sit' });
    }
    seats.push({ x: tx + 2.55, z: tz, rotY: -Math.PI / 2, pose: 'sit' });
    seats.push({ x: tx - 2.55, z: tz, rotY: Math.PI / 2, pose: 'sit' });
    for (const s of seats) this.chair(s.x, s.z, s.rotY + Math.PI);
    this.spots.meeting = seats;

    // TV laporan
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    this.tvCanvas = c;
    this.tvTex = new THREE.CanvasTexture(c);
    this.tvTex.colorSpace = THREE.SRGBColorSpace;
    this.box(3.3, 1.9, 0.08, '#0b0f19', tx, 1.05, minZ + 0.06);
    const tv = new THREE.Mesh(new THREE.PlaneGeometry(3.15, 1.77), new THREE.MeshBasicMaterial({ map: this.tvTex }));
    tv.position.set(tx, 2.0, minZ + 0.11);
    this.scene.add(tv);
    this.setTv('Laporan rapat', ['Belum ada rapat hari ini.', 'Klik “Rapat” untuk mulai diskusi tim.']);

    this.label('▣ Ruang Meeting', x0 + 1.2, 2.7, z1);
    this.doorPoint = { x: (doorA + doorB) / 2, z: z1 };
  }

  setTv(title, lines = []) {
    const g = this.tvCanvas.getContext('2d');
    const { width: w, height: h } = this.tvCanvas;
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#1e3a8a');
    bg.addColorStop(1, '#172554');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#93c5fd';
    g.font = '16px sans-serif';
    g.fillText(new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }), 28, 34);
    g.fillStyle = '#ffffff';
    g.font = 'bold 34px sans-serif';
    g.fillText(title.slice(0, 32), 28, 80);
    g.font = '19px sans-serif';
    g.fillStyle = '#e0e7ff';
    let y = 120;
    for (const line of lines) {
      for (const part of wrapText(g, line, w - 56)) {
        if (y > h - 16) break;
        g.fillText(part, 28, y);
        y += 26;
      }
      y += 4;
    }
    this.tvTex.needsUpdate = true;
  }

  // ---------- pojok kopi ----------

  #coffeeCorner(x) {
    const z = ROOM.minZ + 0.35;
    this.box(2.6, 0.9, 0.62, '#e7e1d6', x, 0, z);
    this.box(2.7, 0.05, 0.68, '#57534e', x, 0.9, z);
    // mesin kopi
    this.box(0.45, 0.5, 0.35, '#1f2937', x - 0.6, 0.95, z - 0.05);
    this.box(0.3, 0.12, 0.2, '#9ca3af', x - 0.6, 1.2, z + 0.1);
    this.cyl(0.05, 0.04, 0.1, '#f8fafc', x - 0.6, 0.95, z + 0.13, { seg: 8 });
    // teko & gelas
    this.cyl(0.1, 0.1, 0.35, '#94a3b8', x + 0.3, 0.95, z, { seg: 10 });
    for (let i = 0; i < 3; i++) this.cyl(0.04, 0.035, 0.09, '#fef3c7', x + 0.7 + i * 0.12, 0.95, z + 0.1, { seg: 8 });
    // kulkas kecil
    this.box(0.7, 1.7, 0.6, '#d4d4d8', x + 1.75, 0, z);
    this.block(x - 1.35, ROOM.minZ, x + 2.15, z + 0.35);
    // stool
    for (const dx of [-0.7, 0.4]) {
      this.cyl(0.2, 0.2, 0.06, '#27272a', x + dx, 0.7, z + 0.85, { seg: 10 });
      this.cyl(0.03, 0.12, 0.7, '#3f3f46', x + dx, 0, z + 0.85, { seg: 6 });
    }
    this.spots.coffee = [
      { x: x - 0.15, z: z + 1.1, rotY: Math.PI, pose: 'stand' },
      { x: x + 1.1, z: z + 1.15, rotY: Math.PI * 0.85, pose: 'stand' },
      { x: x - 1.2, z: z + 1.2, rotY: Math.PI * 1.15, pose: 'stand' },
    ];
    this.label('☕ pojok kopi', x, 2.2, z + 0.2);
  }

  // ---------- lounge ----------

  #lounge() {
    const cx = 7.6;
    const cz = 3.7;
    this.box(5.4, 0.02, 3.6, '#cfc7b8', cx, 0, cz, { shadow: false });
    // sofa (menghadap -z)
    const sofa = (x, z, rotY, w) => {
      const g = new THREE.Group();
      this.box(w, 0.42, 0.9, PALETTE.sofa, 0, 0, 0, { parent: g });
      this.box(w, 0.5, 0.25, PALETTE.sofa, 0, 0.42, 0.33, { parent: g });
      this.box(0.25, 0.25, 0.9, '#9c958f', -w / 2 + 0.12, 0.42, 0, { parent: g });
      this.box(0.25, 0.25, 0.9, '#9c958f', w / 2 - 0.12, 0.42, 0, { parent: g });
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      this.scene.add(g);
    };
    sofa(cx, cz + 1.2, 0, 2.6);
    sofa(cx - 2.1, cz - 0.1, -Math.PI / 2, 1.5);
    this.block(cx - 1.3, cz + 0.8, cx + 1.3, cz + 1.7);
    this.block(cx - 2.6, cz - 0.9, cx - 1.7, cz + 0.7);
    // meja kopi + laptop
    this.box(1.4, 0.36, 0.7, '#e7e5e4', cx, 0, cz - 0.1);
    this.box(0.4, 0.02, 0.3, '#1f2937', cx + 0.2, 0.36, cz - 0.1);
    const lid = this.box(0.4, 0.28, 0.02, '#1f2937', cx + 0.2, 0.37, cz - 0.24);
    lid.rotation.x = -0.25;
    this.block(cx - 0.75, cz - 0.5, cx + 0.75, cz + 0.3);
    // lampu lantai
    this.cyl(0.18, 0.18, 0.04, PALETTE.metal, cx + 2.1, 0, cz + 1.3);
    this.cyl(0.02, 0.02, 1.5, PALETTE.metal, cx + 2.1, 0, cz + 1.3, { seg: 6 });
    const shade = this.cyl(0.18, 0.26, 0.35, null, cx + 2.1, 1.5, cz + 1.3, { material: new THREE.MeshLambertMaterial({ color: PALETTE.lamp }) });
    this.themeHooks.push((dark) => shade.material.emissive.set(dark ? '#ffcf7a' : '#000000'));
    this.block(cx + 1.85, cz + 1.05, cx + 2.35, cz + 1.55);

    this.spots.lounge = [
      { x: cx - 0.6, z: cz + 1.05, rotY: Math.PI, pose: 'sofa' },
      { x: cx + 0.6, z: cz + 1.05, rotY: Math.PI, pose: 'sofa' },
      { x: cx - 1.95, z: cz - 0.1, rotY: Math.PI / 2, pose: 'sofa' },
    ];
    this.label('🛋 lounge', cx, 1.6, cz + 1.6);
  }

  // ---------- navigasi grid (A*) ----------

  buildNavGrid(cell = 0.25, radius = 0.28) {
    const { minX, maxX, minZ, maxZ } = ROOM;
    const cols = Math.ceil((maxX - minX) / cell);
    const rows = Math.ceil((maxZ - minZ) / cell);
    const blocked = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = minX + (c + 0.5) * cell;
        const z = minZ + (r + 0.5) * cell;
        if (x < minX + radius || x > maxX - radius || z < minZ + radius || z > maxZ - radius) blocked[r * cols + c] = 1;
        for (const [x1, z1, x2, z2] of this.obstacles) {
          if (x > x1 - radius && x < x2 + radius && z > z1 - radius && z < z2 + radius) {
            blocked[r * cols + c] = 1;
            break;
          }
        }
      }
    }
    this.nav = { cell, cols, rows, blocked };
  }

  findPath(from, to) {
    const { cell, cols, rows, blocked } = this.nav;
    const toCell = (p) => [
      Math.max(0, Math.min(cols - 1, Math.floor((p.x - ROOM.minX) / cell))),
      Math.max(0, Math.min(rows - 1, Math.floor((p.z - ROOM.minZ) / cell))),
    ];
    const nearestFree = ([c, r]) => {
      if (!blocked[r * cols + c]) return [c, r];
      for (let d = 1; d < 12; d++) {
        let best = null;
        for (let dr = -d; dr <= d; dr++) {
          for (let dc = -d; dc <= d; dc++) {
            const nc = c + dc;
            const nr = r + dr;
            if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || blocked[nr * cols + nc]) continue;
            const dist = dc * dc + dr * dr;
            if (!best || dist < best[2]) best = [nc, nr, dist];
          }
        }
        if (best) return [best[0], best[1]];
      }
      return [c, r];
    };
    const [sc, sr] = nearestFree(toCell(from));
    const [gc, gr] = nearestFree(toCell(to));
    const start = sr * cols + sc;
    const goal = gr * cols + gc;
    const g = new Float32Array(cols * rows).fill(Infinity);
    const came = new Int32Array(cols * rows).fill(-1);
    const closed = new Uint8Array(cols * rows);
    const open = new MinHeap();
    const h = (i) => Math.hypot((i % cols) - gc, Math.floor(i / cols) - gr);
    g[start] = 0;
    open.push(start, h(start));
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    while (open.size) {
      const cur = open.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % cols;
      const cr = Math.floor(cur / cols);
      for (const [dc, dr, cost] of dirs) {
        const nc = cc + dc;
        const nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (blocked[ni] || closed[ni]) continue;
        if (dc && dr && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue; // jangan potong sudut
        const ng = g[cur] + cost;
        if (ng < g[ni]) {
          g[ni] = ng;
          came[ni] = cur;
          open.push(ni, ng + h(ni));
        }
      }
    }
    if (came[goal] === -1 && goal !== start) return [{ x: to.x, z: to.z }];
    const cells = [];
    for (let i = goal; i !== -1; i = came[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => ({ x: ROOM.minX + ((i % cols) + 0.5) * cell, z: ROOM.minZ + (Math.floor(i / cols) + 0.5) * cell }));
    // perhalus: buang titik yang masih bisa dilihat langsung
    const smooth = [pts[0]];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this.#lineFree(pts[anchor], pts[i])) {
        smooth.push(pts[i - 1]);
        anchor = i - 1;
      }
    }
    smooth.push(pts[pts.length - 1], { x: to.x, z: to.z });
    return smooth.slice(1);
  }

  #lineFree(a, b) {
    const { cell, cols, blocked } = this.nav;
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (cell * 0.5));
    for (let s = 0; s <= steps; s++) {
      const x = a.x + ((b.x - a.x) * s) / steps;
      const z = a.z + ((b.z - a.z) * s) / steps;
      const c = Math.floor((x - ROOM.minX) / cell);
      const r = Math.floor((z - ROOM.minZ) / cell);
      if (blocked[r * cols + c]) return false;
    }
    return true;
  }

  render(dt, t) {
    for (const fn of this.animated) fn(dt, t);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
}

function fit(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function wrapText(g, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

class MinHeap {
  constructor() {
    this.items = [];
    this.prios = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, prio) {
    const a = this.items;
    const p = this.prios;
    let i = a.length;
    a.push(item);
    p.push(prio);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (p[parent] <= p[i]) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      [p[i], p[parent]] = [p[parent], p[i]];
      i = parent;
    }
  }
  pop() {
    const a = this.items;
    const p = this.prios;
    const top = a[0];
    const lastItem = a.pop();
    const lastPrio = p.pop();
    if (a.length) {
      a[0] = lastItem;
      p[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && p[l] < p[m]) m = l;
        if (r < a.length && p[r] < p[m]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        [p[i], p[m]] = [p[m], p[i]];
        i = m;
      }
    }
    return top;
  }
}
