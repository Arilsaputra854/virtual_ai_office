import * as THREE from 'three';
import { World } from './world.js';
import { Office, stripThink } from './office.js';
import { STATUS } from './agent.js';
import { getConfig, subscribe } from './api.js';
import { setupBoard, boardEvent, showBoard } from './boardui.js';
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
  setupBoard({ office, config, openChat, toast });
  subscribe((ev) => {
    office.applyEvent(ev);
    boardEvent(ev);
    if (ev.type === 'report') onReport(ev);
  });

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
    const hit = ray.intersectObjects([...roots, world.kanbanMesh], true)[0];
    if (hit?.object === world.kanbanMesh) showBoard('papan');
    else if (hit) openChat(hit.object.userData.agentId);
  });
}

// ---------- panel chat & rapat ----------

const panel = { mode: null, agentId: null, controller: null };
const chatting = new Set(); // agen yang sedang membalas chat kita

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
  setBusy(chatting.has(agentId));
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
  for (const m of history) box.appendChild(messageEl(m.role, m.content, null, m.tools));
  box.scrollTop = box.scrollHeight;
}

function messageEl(role, content, name, tools = []) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (name) div.innerHTML = `<div class="msg-name"></div>`;
  if (name) div.firstChild.textContent = name;
  const toolBox = document.createElement('div');
  toolBox.className = 'tools';
  for (const t of tools || []) toolBox.appendChild(toolChip(t));
  div.appendChild(toolBox);
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : renderMarkdown(stripThink(content));
  div.appendChild(body);
  return div;
}

const TOOL_ICON = { create_task: '📌', update_task: '🗂', list_tasks: '📋', ask_agent: '💬', read_file: '📖', write_file: '📝', list_files: '📁', fetch_url: '🌐' };

function toolChip(t) {
  const el = document.createElement('div');
  el.className = 'tool-chip' + (t.ok === false ? ' fail' : t.ok ? ' ok' : '');
  const a = t.args || {};
  const who = (ref) => office.get(ref)?.data.name || ref;
  const desc =
    {
      create_task: `delegasi ke ${who(a.assignee)}: ${a.title || ''}`,
      ask_agent: `tanya ${who(a.agent)}: ${a.question || ''}`,
      update_task: `kartu #${a.id}${a.status ? ' → ' + a.status : ''}${a.note ? ' — ' + a.note : ''}`,
      write_file: `tulis ${a.path}`,
      read_file: `baca ${a.path}`,
      fetch_url: a.url,
    }[t.name] || t.name;
  el.textContent = `${TOOL_ICON[t.name] || '🔧'} ${desc}`;
  if (t.text) el.title = t.text;
  return el;
}

function setBusy(busy) {
  $('#btn-send').hidden = busy;
  $('#btn-stop').hidden = !busy;
}

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  const agentId = panel.agentId;
  if (!text || panel.mode !== 'chat' || chatting.has(agentId)) return;
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
  const toolBox = reply.querySelector('.tools');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  const tools = [];

  panel.controller = new AbortController();
  chatting.add(agentId);
  setBusy(true);
  try {
    const res = await office.chat(agentId, history, {
      signal: panel.controller.signal,
      onEvent: (ev) => {
        if (ev.agentId !== agentId) return;
        if (ev.type === 'delta') body.innerHTML = renderMarkdown(stripThink(ev.text)) || body.innerHTML;
        if (ev.type === 'tool') tools.push({ name: ev.name, args: ev.args });
        if (ev.type === 'tool_result') Object.assign(tools.findLast((t) => t.name === ev.name && t.ok === undefined) || {}, { ok: ev.ok, text: ev.text });
        if (ev.type === 'tool' || ev.type === 'tool_result') toolBox.replaceChildren(...tools.map(toolChip));
        if (panel.agentId === agentId) box.scrollTop = box.scrollHeight;
      },
    });
    body.innerHTML = renderMarkdown(stripThink(res.text)) || '<small>(tanpa teks)</small>';
    history.push({ role: 'assistant', content: res.text || '(selesai)', tools });
    store.set(key, history);
    if (res.taskId) toast(`📋 Tugas dibagikan ke tim (kartu #${res.taskId}). Laporan akan dikirim saat selesai.`, 5000);
  } catch (err) {
    if (err.name !== 'AbortError') {
      body.innerHTML = `<span class="err">⚠️ ${escapeHtml(err.message)}</span>`;
      reply.classList.add('error');
    } else body.innerHTML += ' <small>(dihentikan)</small>';
  } finally {
    reply.classList.remove('streaming');
    panel.controller = null;
    chatting.delete(agentId);
    if (panel.agentId === agentId) setBusy(false);
  }
}

// Laporan akhir dari koordinasi yang dimulai lewat chat.
function onReport(ev) {
  const a = office.get(ev.agentId);
  if (!a) return;
  const key = 'chat.' + ev.agentId;
  const history = store.get(key, []);
  if (history.some((m) => m.reportId === ev.taskId && m.content.includes(ev.text))) return;
  history.push({ role: 'assistant', content: `📋 **Laporan #${ev.taskId}: ${ev.title.replace(/^Koordinasi:\s*/, '')}**\n\n${ev.text}`, reportId: ev.taskId });
  store.set(key, history);
  if (panel.mode === 'chat' && panel.agentId === ev.agentId && !chatting.has(ev.agentId)) renderChat();
  toast(`📋 ${a.data.name} mengirim laporan hasil kerja tim. Klik namanya untuk membaca.`, 6000);
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
    startMeeting({ topic, ids: ids.slice(0, world.spots.meeting.length), rounds: Number($('#meeting-rounds').value), toTasks: $('#meeting-tasks').checked });
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
    if (opts.toTasks) await meetingToTasks(opts, meeting, note, add);
  } catch {
    /* sudah ditampilkan lewat event 'error' */
  }
}

// Pemimpin rapat mengubah poin TUGAS jadi kartu kanban (lewat tool create_task),
// lalu tim otomatis mengerjakannya dan pemimpin mengirim laporan.
async function meetingToTasks(opts, meeting, note, add) {
  const leader = office.get(opts.ids[0]);
  note(`${leader.data.name} membagikan tugas ke kanban…`);
  const others = opts.ids.slice(1).map((id) => office.get(id).data.name).join(', ');
  const prompt = `Rapat "${opts.topic}" baru selesai. Kesimpulannya:\n\n${meeting.summary}\n\nBuat kartu kanban dengan create_task untuk setiap poin TUGAS yang ditujukan ke rekan (${others}), dengan detail yang jelas dan bisa langsung dikerjakan. Tugas untuk dirimu sendiri tidak perlu dibuat kartunya. Setelah itu jawab singkat siapa mengerjakan apa.`;
  const el = messageEl('assistant', '', `${leader.data.name} · pembagian tugas`);
  el.style.setProperty('--c', leader.data.color);
  el.classList.add('meet', 'streaming');
  add(el);
  const tools = [];
  try {
    const res = await office.chat(leader.id, [{ role: 'user', content: prompt }], {
      onEvent: (ev) => {
        if (ev.agentId !== leader.id) return;
        if (ev.type === 'tool') tools.push({ name: ev.name, args: ev.args });
        if (ev.type === 'tool_result') Object.assign(tools.findLast((t) => t.name === ev.name && t.ok === undefined) || {}, { ok: ev.ok, text: ev.text });
        el.querySelector('.tools').replaceChildren(...tools.map(toolChip));
        if (ev.type === 'delta') el.querySelector('.msg-body').innerHTML = renderMarkdown(stripThink(ev.text));
      },
    });
    el.querySelector('.msg-body').innerHTML = renderMarkdown(stripThink(res.text));
    if (!tools.some((t) => t.name === 'create_task')) note('Model tidak membuat kartu (mungkin tidak mendukung tool calling). Buat manual di 📋 Kanban.', 'note err');
  } catch (err) {
    note('Gagal membagi tugas: ' + err.message, 'note err');
  } finally {
    el.classList.remove('streaming');
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
