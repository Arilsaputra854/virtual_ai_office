// Karakter agen low-poly: badan, animasi jalan/duduk, label nama, dan balon bicara.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const SKIN = ['#f1c7a0', '#e0ac85', '#c68863', '#9a6646'];
const HAIR = ['#1f1611', '#3b2416', '#111827', '#5b3a1e'];
const PANTS = ['#1f2937', '#27354f', '#3f3f46', '#2d2a26'];

export const STATUS = {
  kerja: 'lagi kerja',
  mikir: 'lagi mikir…',
  ngetik: 'lagi ngetik…',
  rapat: 'lagi rapat',
  ngopi: 'ngopi',
  santai: 'santai',
  jalan: 'jalan',
  error: 'error',
};

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export class AgentAvatar {
  constructor(world, data) {
    this.world = world;
    this.data = data;
    this.id = data.id;
    this.speed = 2.2;
    this.path = [];
    this.pose = 'stand';
    this.walkT = 0;
    this.busy = new Set(); // alasan sibuk: 'chat', 'rapat'
    this.#build();
    world.scene.add(this.root);
  }

  #build() {
    const h = hash(this.data.id);
    const m = (c) => new THREE.MeshLambertMaterial({ color: c });
    const shirt = m(this.data.color);
    const skin = m(SKIN[h % SKIN.length]);
    const hair = m(HAIR[(h >> 3) % HAIR.length]);
    const pants = m(PANTS[(h >> 5) % PANTS.length]);
    const mesh = (geo, mat, x, y, z, parent) => {
      const o = new THREE.Mesh(geo, mat);
      o.position.set(x, y, z);
      o.castShadow = true;
      parent.add(o);
      return o;
    };

    this.root = new THREE.Group();
    this.body = new THREE.Group(); // naik-turun saat duduk
    this.root.add(this.body);

    // kaki (pivot di pinggul)
    this.legs = [-0.09, 0.09].map((x) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.52, 0);
      mesh(new THREE.BoxGeometry(0.14, 0.52, 0.16), pants, 0, -0.26, 0, pivot);
      mesh(new THREE.BoxGeometry(0.15, 0.07, 0.24), m('#111111'), 0, -0.5, 0.04, pivot);
      this.body.add(pivot);
      return pivot;
    });
    // badan
    mesh(new THREE.CapsuleGeometry(0.2, 0.3, 3, 10), shirt, 0, 0.84, 0, this.body).scale.set(1, 1, 0.75);
    // kepala + rambut
    this.head = new THREE.Group();
    this.head.position.set(0, 1.27, 0);
    this.body.add(this.head);
    mesh(new THREE.SphereGeometry(0.17, 14, 10), skin, 0, 0, 0, this.head);
    const hairMesh = mesh(new THREE.SphereGeometry(0.185, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, 0, 0.02, -0.02, this.head);
    hairMesh.rotation.x = -0.25;
    // tangan (pivot di bahu)
    this.arms = [-0.25, 0.25].map((x) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 1.04, 0);
      mesh(new THREE.CapsuleGeometry(0.055, 0.34, 2, 6), shirt, 0, -0.2, 0, pivot);
      mesh(new THREE.SphereGeometry(0.055, 8, 6), skin, 0, -0.42, 0, pivot);
      this.body.add(pivot);
      return pivot;
    });

    // Label nama
    const el = document.createElement('div');
    el.className = 'agent-tag';
    el.style.setProperty('--c', this.data.color);
    el.innerHTML = `<div class="bubble" hidden></div><div class="pill"><span class="pulse"></span><b></b><small></small></div>`;
    el.querySelector('b').textContent = this.data.tag ? `${this.data.name} (${this.data.tag})` : this.data.name;
    this.tagEl = el;
    this.bubbleEl = el.querySelector('.bubble');
    this.statusEl = el.querySelector('small');
    const label = new CSS2DObject(el);
    label.position.set(0, 2.05, 0);
    this.root.add(label);
    this.label = label;

    this.root.traverse((o) => (o.userData.agentId = this.id));
  }

  setStatus(key, extra) {
    this.status = key;
    this.statusEl.textContent = extra || STATUS[key] || key;
    this.tagEl.dataset.status = key;
  }

  say(text, ms = 6000) {
    clearTimeout(this.bubbleTimer);
    const clean = String(text || '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) {
      this.bubbleEl.hidden = true;
      return;
    }
    this.bubbleEl.textContent = clean.length > 140 ? '…' + clean.slice(-140) : clean;
    this.bubbleEl.hidden = false;
    if (ms) this.bubbleTimer = setTimeout(() => (this.bubbleEl.hidden = true), ms);
  }

  place(spot) {
    this.root.position.set(spot.x, 0, spot.z);
    this.root.rotation.y = spot.rotY;
    this.spot = spot;
    this.setPose(spot.pose);
  }

  // Jalan ke spot lewat grid navigasi. Resolve saat sampai.
  goTo(spot) {
    this.arrive?.(false);
    this.spot = spot;
    this.path = this.world.findPath({ x: this.root.position.x, z: this.root.position.z }, spot);
    this.setPose('stand');
    return new Promise((resolve) => {
      this.arrive = (ok = true) => {
        this.arrive = null;
        resolve(ok);
      };
    });
  }

  setPose(pose) {
    this.pose = pose;
    const sitting = pose === 'sit' || pose === 'sofa';
    this.body.position.y = pose === 'sofa' ? -0.12 : 0;
    this.body.position.z = sitting ? 0.12 : 0;
    for (const leg of this.legs) leg.rotation.x = sitting ? -Math.PI / 2 : 0;
    for (const arm of this.arms) arm.rotation.x = pose === 'sit' ? -0.9 : 0;
  }

  update(dt, t) {
    if (this.path.length) {
      const target = this.path[0];
      const pos = this.root.position;
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist <= step) {
        pos.x = target.x;
        pos.z = target.z;
        this.path.shift();
      } else {
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
      }
      if (dist > 0.01) this.root.rotation.y = lerpAngle(this.root.rotation.y, Math.atan2(dx, dz), Math.min(1, dt * 12));
      this.walkT += dt * 9;
      const swing = Math.sin(this.walkT) * 0.55;
      this.legs[0].rotation.x = swing;
      this.legs[1].rotation.x = -swing;
      this.arms[0].rotation.x = -swing * 0.8;
      this.arms[1].rotation.x = swing * 0.8;
      this.body.position.y = Math.abs(Math.cos(this.walkT)) * 0.04;
      if (!this.path.length) {
        this.root.rotation.y = this.spot.rotY;
        this.setPose(this.spot.pose);
        this.arrive?.(true);
      }
      return;
    }

    // animasi idle
    const phase = hash(this.id) % 10;
    if (this.pose === 'sit' && (this.status === 'ngetik' || this.status === 'kerja' || this.status === 'mikir')) {
      const speed = this.status === 'ngetik' ? 22 : this.status === 'mikir' ? 0 : 6;
      this.arms[0].rotation.x = -0.9 + Math.sin(t * speed + phase) * 0.08;
      this.arms[1].rotation.x = -0.9 + Math.cos(t * speed + phase) * 0.08;
    }
    this.head.rotation.y = this.status === 'mikir' ? Math.sin(t * 1.5 + phase) * 0.35 : Math.sin(t * 0.4 + phase) * 0.12;
    this.head.rotation.x = this.status === 'mikir' ? -0.15 : 0;
    if (this.pose === 'stand') this.body.position.y = Math.sin(t * 2 + phase) * 0.008;
  }

  dispose() {
    this.world.scene.remove(this.root);
    this.label.element.remove();
  }
}

function lerpAngle(a, b, f) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
