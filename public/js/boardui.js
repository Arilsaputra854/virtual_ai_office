// Panel kanban: papan tugas, feed aktivitas tim, dan berkas workspace.
import { tasks as tasksApi, files as filesApi } from './api.js';
import { renderMarkdown, escapeHtml } from './markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const COLUMNS = [
  ['todo', 'Todo'],
  ['proses', 'Proses'],
  ['review', 'Review'],
  ['selesai', 'Selesai'],
  ['gagal', 'Gagal'],
];

const state = { tab: 'papan', tasks: [], log: [], expanded: new Set(), file: null };
let ctx;

export function setupBoard(context) {
  ctx = context;
  $('#btn-board').onclick = () => (isOpen() ? close() : showBoard());
  ctx.office.world.kanbanLabel.onclick = () => showBoard();
  $('#board-close').onclick = close;
  $('#board-clear').onclick = async () => {
    if (!confirm('Hapus semua kartu yang sudah selesai/gagal?')) return;
    await tasksApi.clearDone().catch((e) => ctx.toast(e.message));
  };
  for (const b of document.querySelectorAll('#board [data-tab]')) {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      state.file = null;
      render();
    };
  }
  const sel = $('#task-assignee');
  sel.innerHTML = `<option value="">(belum ditugaskan)</option>` + ctx.config.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.role ? ' — ' + escapeHtml(a.role) : ''}</option>`).join('');
  $('#task-form').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#task-title').value.trim();
    if (!title) return;
    try {
      await tasksApi.create({ title, detail: $('#task-detail').value.trim(), assignee: sel.value || null });
      $('#task-title').value = '';
      $('#task-detail').value = '';
      $('#task-new').open = false;
    } catch (err) {
      ctx.toast(err.message);
    }
  };
}

export function showBoard(tab) {
  if (tab) state.tab = tab;
  $('#board').hidden = false;
  render();
}

const isOpen = () => !$('#board').hidden;
function close() {
  $('#board').hidden = true;
}

export function boardEvent(ev) {
  if (ev.type === 'board') {
    state.tasks = ev.tasks;
    if (isOpen() && state.tab === 'papan') render();
    updateCounter();
  } else if (ev.type === 'log') {
    state.log.unshift(ev);
    state.log.length = Math.min(state.log.length, 200);
    if (isOpen() && state.tab === 'aktivitas') render();
  } else if (ev.type === 'files') {
    if (isOpen() && state.tab === 'berkas' && !state.file) render();
  }
}

function updateCounter() {
  const open = state.tasks.filter((t) => ['todo', 'proses', 'review'].includes(t.status)).length;
  $('#board-count').textContent = open ? String(open) : '';
  $('#board-sub').textContent = `${open} terbuka · ${state.tasks.length} total${ctx.config.autoRun ? '' : ' · jalan otomatis MATI'}`;
}

const agentName = (id) => (id === 'user' ? 'kamu' : ctx.office.get(id)?.data.name || id || '—');
const agentColor = (id) => ctx.office.get(id)?.data.color || '#94a3b8';

function render() {
  for (const b of document.querySelectorAll('#board [data-tab]')) b.classList.toggle('active', b.dataset.tab === state.tab);
  $('#task-new').hidden = state.tab !== 'papan';
  const body = $('#board-body');
  updateCounter();
  if (state.tab === 'papan') renderBoard(body);
  else if (state.tab === 'aktivitas') renderLog(body);
  else renderFiles(body);
}

// ---------- papan ----------

function renderBoard(body) {
  const scroll = body.scrollTop;
  body.innerHTML = '';
  if (!state.tasks.length) {
    body.innerHTML = `<div class="empty">Belum ada tugas.<br><small>Tambah kartu di atas, atau minta agen (mis. GM) untuk mengoordinasikan tim lewat chat.</small></div>`;
    return;
  }
  for (const [status, label] of COLUMNS) {
    const list = state.tasks.filter((t) => t.status === status).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length && (status === 'gagal' || status === 'review')) continue;
    const col = document.createElement('section');
    col.className = 'kcol';
    col.dataset.status = status;
    col.innerHTML = `<h4>${label} <span>${list.length}</span></h4>`;
    for (const t of list) col.appendChild(card(t));
    body.appendChild(col);
  }
  body.scrollTop = scroll;
}

function card(t) {
  const el = document.createElement('article');
  el.className = 'kcard' + (state.expanded.has(t.id) ? ' open' : '');
  el.style.setProperty('--c', agentColor(t.assignee));
  const parent = t.parentId ? state.tasks.find((p) => p.id === t.parentId) : null;
  const kids = state.tasks.filter((c) => c.parentId === t.id);
  const meta = [
    t.assignee ? `👤 ${escapeHtml(agentName(t.assignee))}` : '👤 belum ditugaskan',
    t.waiting ? '⏳ menunggu subtugas' : '',
    kids.length ? `🧩 ${kids.filter((k) => k.status === 'selesai' || k.status === 'review').length}/${kids.length} subtugas` : '',
    t.revisions ? `🔁 revisi ${t.revisions}x` : '',
  ].filter(Boolean);
  el.innerHTML = `
    <header><b>#${t.id}</b> <span class="ktitle"></span></header>
    <div class="kmeta">${meta.join(' · ')}</div>
    <div class="kdetail">
      <div class="kfrom">dari ${escapeHtml(agentName(t.createdBy))}${parent ? ` · bagian dari <a href="#" data-goto="${parent.id}">#${parent.id}</a>` : ''}</div>
      ${t.detail ? `<div class="ktext"></div>` : ''}
      ${t.result ? `<div class="kresult"><div class="klabel">Hasil</div>${renderMarkdown(t.result)}</div>` : ''}
      ${t.notes.length ? `<ul class="knotes">${t.notes.map((n) => `<li><b>${escapeHtml(agentName(n.by))}:</b> ${escapeHtml(n.text)}</li>`).join('')}</ul>` : ''}
      <div class="kactions">
        ${t.assignee ? '' : `<select data-act="assign"><option value="">Tugaskan ke…</option>${ctx.config.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')}</select>`}
        ${t.status === 'proses' ? `<button class="btn small" data-act="stop">⏹ Hentikan</button>` : ''}
        ${t.status !== 'proses' && t.assignee ? `<button class="btn small" data-act="run">${t.status === 'todo' ? '▶ Jalankan' : '↻ Kerjakan ulang'}</button>` : ''}
        ${t.assignee ? `<button class="btn small" data-act="chat">💬 Chat ${escapeHtml(agentName(t.assignee))}</button>` : ''}
        <button class="btn small danger" data-act="delete">🗑 Hapus</button>
      </div>
    </div>`;
  $('.ktitle', el).textContent = t.title;
  if (t.detail) $('.ktext', el).textContent = t.detail;
  el.querySelector('header').onclick = () => {
    state.expanded.has(t.id) ? state.expanded.delete(t.id) : state.expanded.add(t.id);
    el.classList.toggle('open');
  };
  el.querySelector('.kmeta').onclick = el.querySelector('header').onclick;
  const act = (name, fn) => {
    const b = el.querySelector(`[data-act=${name}]`);
    if (b) b[name === 'assign' ? 'onchange' : 'onclick'] = (e) => fn(e).catch?.((err) => ctx.toast(err.message));
  };
  act('run', () => tasksApi.update(t.id, { status: 'todo' }));
  act('stop', () => (confirm(`Hentikan kartu #${t.id}${kids.length ? ' beserta subtugasnya' : ''}?`) ? tasksApi.stop(t.id) : Promise.resolve()));
  act('assign', (e) => e.target.value && tasksApi.update(t.id, { assignee: e.target.value }));
  act('chat', async () => ctx.openChat(t.assignee));
  act('delete', () => (confirm(`Hapus kartu #${t.id}${kids.length ? ' beserta subtugasnya' : ''}?`) ? tasksApi.remove(t.id) : Promise.resolve()));
  const goto = el.querySelector('[data-goto]');
  if (goto)
    goto.onclick = (e) => {
      e.preventDefault();
      state.expanded.add(Number(goto.dataset.goto));
      render();
    };
  return el;
}

// ---------- aktivitas ----------

function renderLog(body) {
  body.innerHTML = '';
  if (!state.log.length) {
    body.innerHTML = `<div class="empty">Belum ada aktivitas sejak halaman dibuka.<br><small>Delegasi, pertanyaan antar agen, file yang ditulis, dan progres tugas akan muncul di sini.</small></div>`;
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'klog';
  for (const ev of state.log) {
    const li = document.createElement('li');
    li.style.setProperty('--c', agentColor(ev.agentId));
    if (ev.error) li.classList.add('err');
    li.innerHTML = `<time>${new Date(ev.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span class="dot"></span><span><b></b> <span class="t"></span></span>`;
    li.querySelector('b').textContent = agentName(ev.agentId);
    li.querySelector('.t').textContent = ev.text;
    if (ev.taskId || ev.file) {
      li.classList.add('link');
      li.onclick = () => {
        if (ev.file) {
          state.tab = 'berkas';
          openFile(ev.file);
        } else {
          state.tab = 'papan';
          state.expanded.add(ev.taskId);
          render();
        }
      };
    }
    ul.appendChild(li);
  }
  body.appendChild(ul);
}

// ---------- berkas ----------

async function renderFiles(body) {
  if (state.file) {
    body.innerHTML = `<div class="kfile-head"><button class="btn small" id="file-back">← Semua berkas</button><code></code><a class="btn small" download>⬇ Unduh</a></div><pre class="kfile"></pre>`;
    $('code', body).textContent = state.file.path;
    $('a', body).href = filesApi.downloadUrl(state.file.path);
    $('pre', body).textContent = state.file.content;
    $('#file-back').onclick = () => {
      state.file = null;
      render();
    };
    return;
  }
  body.innerHTML = '<div class="empty">Memuat…</div>';
  try {
    const { files } = await filesApi.list();
    if (state.tab !== 'berkas' || state.file) return;
    if (!files.length) {
      body.innerHTML = `<div class="empty">Workspace masih kosong.<br><small>Agen menyimpan dokumen & kode di sini lewat tool <code>write_file</code> (folder <code>data/workspace/</code>).</small></div>`;
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'kfiles';
    for (const f of files) {
      const li = document.createElement('li');
      li.innerHTML = `<span>📄 <span class="p"></span></span><span class="fmeta"><small>${(f.size / 1024).toFixed(1)} KB · ${new Date(f.updatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</small><a class="icon-btn" title="Unduh" download>⬇</a></span>`;
      li.querySelector('.p').textContent = f.path;
      const dl = li.querySelector('a');
      dl.href = filesApi.downloadUrl(f.path);
      dl.onclick = (e) => e.stopPropagation();
      li.onclick = () => openFile(f.path);
      ul.appendChild(li);
    }
    body.replaceChildren(ul);
  } catch (err) {
    body.innerHTML = `<div class="empty err">${escapeHtml(err.message)}</div>`;
  }
}

async function openFile(path) {
  try {
    state.file = await filesApi.read(path);
  } catch (err) {
    ctx.toast(err.message);
    state.file = null;
  }
  showBoard('berkas');
}
