import * as THREE from 'three';
import { World } from './world.js';
import { Office, stripThink } from './office.js';
import { STATUS } from './agent.js';
import { getConfig } from './api.js';
import { openSettings } from './settings.js';
import { renderMarkdown, escapeHtml } from './markdown.js';

const $ = (sel) => document.querySelector(sel);
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('vao.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('vao.' + key, JSON.stringify(value));
    } catch {
      /* storage penuh / diblokir — abaikan */
    }
  },
};

let config;
let world;
let office;

async function boot() {
  try {
    config = await getConfig();
  } catch (err) {
    toast('Gagal memuat config: ' + err.message, 8000);
    return;
  }
  $('#office-name').textContent = config.officeName || 'Kantor AI';
  document.title = config.officeName || 'Virtual AI Office';

  world = new World($('#stage'));
  setupTheme();
  office = new Office(world, config);
  setupRoster();
  setupPicking();
  setupPanel();
  setupMeeting();

  $('#btn-reset-cam').onclick = () => world.resetCamera();
  $('#btn-settings').onclick = () => openSettings(config, () => location.reload());

  const clock = new THREE.Clock();
  const loop = () => {
    const dt = Math.min(clock.getDelta(), 0.25);
    world.render(dt, clock.elapsedTime);
    requestAnimationFrame(loop);
  };
  loop();

  if (!config.providers.some((p) => p.hasKey) && config.providers.every((p) => !/localhost|127\.0\.0\.1/.test(p.baseUrl))) {
    toast('Belum ada API key. Buka ⚙️ Pengaturan untuk menghubungkan provider.', 7000);
  }
}

// ---------- tema ----------

function setupTheme() {
  let mode = store.get('theme', 'auto');
  const apply = () => {
    const hour = new Date().getHours();
    const dark = mode === 'dark' || (mode === 'auto' && (hour < 6 || hour >= 18));
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    world.setTheme(dark);
    for (const b of document.querySelectorAll('[data-theme-mode]')) b.classList.toggle('active', b.dataset.themeMode === mode);
  };
  for (const b of document.querySelectorAll('[data-theme-mode]')) {
    b.onclick = () => {
      mode = b.dataset.themeMode;
      store.set('theme', mode);
      apply();
    };
  }
  apply();
  setInterval(() => mode === 'auto' && apply(), 60_000);
}

// ---------- daftar agen ----------

function setupRoster() {
  const ul = $('#roster');
  ul.innerHTML = '';
  for (const a of office.avatars.values()) {
    const li = document.createElement('li');
    li.style.setProperty('--c', a.data.color);
    li.innerHTML = `<span class="dot"></span><span class="r-name"></span><span class="r-status"></span>`;
    li.querySelector('.r-name').textContent = a.data.name;
    li.title = `${a.data.role || ''} — klik untuk chat`;
    li.onclick = () => openChat(a.id);
    ul.appendChild(li);
    a.rosterStatus = li.querySelector('.r-status');
    const setStatus = a.setStatus.bind(a);
    a.setStatus = (key, extra) => {
      setStatus(key, extra);
      a.rosterStatus.textContent = extra || STATUS[key] || key;
      li.dataset.status = key;
    };
    a.setStatus(a.status);
    a.tagEl.onclick = () => openChat(a.id);
  }
}

// Klik badan karakter untuk membuka chat.
function setupPicking() {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  const el = world.labelRenderer.domElement;
  el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, world.camera);
    const roots = [...office.avatars.values()].map((a) => a.root);
    const hit = ray.intersectObjects(roots, true)[0];
    if (hit) openChat(hit.object.userData.agentId);
  });
}

// ---------- panel chat & rapat ----------

const panel = { mode: null, agentId: null, controller: null };

function setupPanel() {
  $('#btn-close').onclick = () => {
    $('#panel').hidden = true;
    panel.mode = null;
  };
  $('#btn-clear').onclick = () => {
    if (panel.mode === 'chat') {
      if (!confirm('Hapus riwayat chat dengan agen ini?')) return;
      store.set('chat.' + panel.agentId, []);
      renderChat();
    } else if (panel.mode === 'meeting' && office.meeting) {
      office.cancelMeeting();
    }
  };
  const input = $('#input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').onsubmit = (e) => {
    e.preventDefault();
    sendMessage();
  };
  $('#btn-stop').onclick = () => panel.controller?.abort();
}

function openChat(agentId) {
  const a = office.get(agentId);
  if (!a) return;
  panel.mode = 'chat';
  panel.agentId = agentId;
  const provider = config.providers.find((p) => p.id === a.data.providerId);
  $('#panel').hidden = false;
  $('#panel').style.setProperty('--c', a.data.color);
  $('#panel-name').textContent = a.data.tag ? `${a.data.name} (${a.data.tag})` : a.data.name;
  $('#panel-sub').textContent = [a.data.role, `${provider?.name || '?'} · ${a.data.model || provider?.defaultModel || 'model belum diatur'}`].filter(Boolean).join(' — ');
  $('#btn-clear').title = 'Hapus riwayat';
  $('#composer').hidden = false;
  renderChat();
  setBusy(a.busy.has('chat'));
  $('#input').focus();
}

function renderChat() {
  const history = store.get('chat.' + panel.agentId, []);
  const box = $('#messages');
  box.innerHTML = '';
  if (!history.length) {
    const a = office.get(panel.agentId);
    box.innerHTML = `<div class="empty">Mulai ngobrol dengan <b>${escapeHtml(a.data.name)}</b>.<br><small>${escapeHtml(a.data.role || '')}</small></div>`;
  }
  for (const m of history) box.appendChild(messageEl(m.role, m.content));
  box.scrollTop = box.scrollHeight;
}

function messageEl(role, content, name) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (name) div.innerHTML = `<div class="msg-name"></div>`;
  if (name) div.firstChild.textContent = name;
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : renderMarkdown(stripThink(content));
  div.appendChild(body);
  return div;
}

function setBusy(busy) {
  $('#btn-send').hidden = busy;
  $('#btn-stop').hidden = !busy;
}

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  const agentId = panel.agentId;
  if (!text || panel.mode !== 'chat' || office.get(agentId).busy.has('chat')) return;
  input.value = '';

  const key = 'chat.' + agentId;
  const history = store.get(key, []);
  history.push({ role: 'user', content: text });
  store.set(key, history);
  renderChat();

  const box = $('#messages');
  const reply = messageEl('assistant', '');
  reply.classList.add('streaming');
  box.appendChild(reply);
  const body = reply.querySelector('.msg-body');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

  panel.controller = new AbortController();
  setBusy(true);
  try {
    const full = await office.chat(agentId, history, {
      signal: panel.controller.signal,
      onDelta: (_d, all) => {
        if (panel.agentId !== agentId) return;
        body.innerHTML = renderMarkdown(stripThink(all));
        box.scrollTop = box.scrollHeight;
      },
    });
    history.push({ role: 'assistant', content: full });
    store.set(key, history);
  } catch (err) {
    if (err.name !== 'AbortError') {
      body.innerHTML = `<span class="err">⚠️ ${escapeHtml(err.message)}</span>`;
      reply.classList.add('error');
    } else body.innerHTML += ' <small>(dihentikan)</small>';
  } finally {
    reply.classList.remove('streaming');
    panel.controller = null;
    if (panel.agentId === agentId) setBusy(false);
  }
}

// ---------- rapat ----------

function setupMeeting() {
  const dlg = $('#dlg-meeting');
  $('#btn-meeting').onclick = () => {
    if (office.meeting) return showMeetingPanel(office.meeting.topic);
    const box = $('#meeting-people');
    box.innerHTML = '';
    for (const a of office.avatars.values()) {
      const label = document.createElement('label');
      label.className = 'chip';
      label.style.setProperty('--c', a.data.color);
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(a.id)}" checked><span></span>`;
      label.querySelector('span').textContent = a.data.name;
      box.appendChild(label);
    }
    dlg.showModal();
  };
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const ids = [...dlg.querySelectorAll('#meeting-people input:checked')].map((i) => i.value);
    const topic = $('#meeting-topic').value.trim();
    if (ids.length < 2) return toast('Pilih minimal 2 peserta.');
    if (!topic) return toast('Topik rapat wajib diisi.');
    startMeeting({ topic, ids: ids.slice(0, world.spots.meeting.length), rounds: Number($('#meeting-rounds').value) });
  });
}

let meetingLog = [];

function showMeetingPanel(topic) {
  panel.mode = 'meeting';
  panel.agentId = null;
  $('#panel').hidden = false;
  $('#panel').style.setProperty('--c', '#6366f1');
  $('#panel-name').textContent = '👥 Ruang Meeting';
  $('#panel-sub').textContent = topic;
  $('#btn-clear').title = 'Batalkan rapat';
  $('#composer').hidden = true;
  const box = $('#messages');
  box.innerHTML = '';
  for (const m of meetingLog) box.appendChild(m.el);
  box.scrollTop = box.scrollHeight;
}

async function startMeeting(opts) {
  meetingLog = [];
  showMeetingPanel(opts.topic);
  const box = $('#messages');
  const add = (el) => {
    meetingLog.push({ el });
    if (panel.mode === 'meeting') {
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    }
  };
  const note = (text, cls = 'note') => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    add(el);
  };
  note(`Topik: ${opts.topic}`, 'note topic');
  let current = null;
  try {
    const meeting = await office.runMeeting(opts, (ev) => {
      if (ev.type === 'status') note(ev.text);
      if (ev.type === 'turn') {
        current = messageEl('assistant', '', `${ev.agent.name} · ${ev.round === 'kesimpulan' ? 'Kesimpulan' : 'putaran ' + ev.round}`);
        current.style.setProperty('--c', ev.agent.color);
        current.classList.add('streaming', 'meet');
        if (ev.round === 'kesimpulan') current.classList.add('summary');
        current.querySelector('.msg-body').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
        add(current);
      }
      if (ev.type === 'delta' && current) {
        current.querySelector('.msg-body').innerHTML = renderMarkdown(stripThink(ev.text));
        if (panel.mode === 'meeting') box.scrollTop = box.scrollHeight;
      }
      if ((ev.type === 'done' || ev.type === 'summary') && current) current.classList.remove('streaming');
      if (ev.type === 'error') {
        current?.classList.remove('streaming');
        note(ev.text, 'note err');
      }
    });
    saveMeeting(opts, meeting);
    note('Rapat selesai. Hasil tampil di layar TV ruang meeting.');
  } catch {
    /* sudah ditampilkan lewat event 'error' */
  }
}

// Simpan hasil rapat ke riwayat chat pemimpin, supaya bisa ditindaklanjuti.
function saveMeeting(opts, meeting) {
  const key = 'chat.' + opts.ids[0];
  const history = store.get(key, []);
  history.push({ role: 'user', content: `[Hasil rapat] Topik: ${opts.topic}` }, { role: 'assistant', content: meeting.summary });
  store.set(key, history);
  const all = store.get('meetings', []);
  all.unshift({ at: Date.now(), topic: opts.topic, ids: opts.ids, transcript: meeting.transcript, summary: meeting.summary });
  store.set('meetings', all.slice(0, 20));
}

// ---------- util ----------

let toastTimer;
export function toast(text, ms = 3500) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

boot();
