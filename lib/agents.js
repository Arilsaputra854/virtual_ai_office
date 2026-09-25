// Otak kantor: loop agen dengan tool calling, dan dispatcher yang menjalankan tugas kanban.
import { readConfig, findAgent } from './config.js';
import { complete, toolsEnabled, stripThink } from './llm.js';
import { emit, throttledSay } from './bus.js';
import * as board from './board.js';
import * as ws from './workspace.js';

const MAX_STEPS = 8; // langkah tool per sekali jalan
const MAX_DEPTH = 2; // kedalaman delegasi (tugas → subtugas → sub-subtugas)
const MAX_OPEN_TASKS = 40;
const MAX_RUNS = 5; // batas eksekusi ulang per kartu (revisi, finalisasi)
const MAX_REVISIONS = 2;
const HTTP_TOOL = process.env.TOOLS_HTTP === '1';

const ACTIVE = new Set(['todo', 'proses']);
const lastStatus = new Map(); // agentId -> event status terakhir
const activeRuns = new Map(); // agentId -> jumlah run yang sedang jalan

function setStatus(agentId, status, text = '', taskId = null) {
  const ev = { type: 'agent', agentId, status, text, taskId };
  lastStatus.set(agentId, ev);
  emit(ev);
}

export function statusSnapshot() {
  return [...lastStatus.values()];
}

function log(agentId, text, extra = {}) {
  emit({ type: 'log', agentId, text, ...extra });
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

// ---------- definisi tools ----------

function toolDefs(ctx) {
  const fn = (name, description, properties, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  const str = (description) => ({ type: 'string', description });
  const defs = [
    fn('list_tasks', 'Lihat kartu di papan kanban tim.', { status: str('Filter: todo | proses | review | selesai | gagal | open (default open)') }),
    fn('update_task', 'Ubah kartu kanban milikmu atau yang kamu buat: pindah status, tambah catatan, atau isi hasil. Untuk minta revisi subtugas, set status="todo" dengan note berisi feedback.', {
      id: { type: 'integer', description: 'Nomor kartu' },
      status: str('todo | proses | review | selesai | gagal'),
      note: str('Catatan / feedback'),
      result: str('Ringkasan hasil kerja'),
    }, ['id']),
    fn('get_task', 'Lihat detail lengkap satu kartu: instruksi, hasil kerja penuh, catatan, dan subtugasnya.', { id: { type: 'integer', description: 'Nomor kartu' } }, ['id']),
    fn('list_files', 'Daftar file di workspace bersama tim.', {}),
    fn('read_file', 'Baca file dari workspace bersama.', { path: str('Path relatif, mis. docs/prd.md') }, ['path']),
    fn('write_file', 'Tulis/timpa file di workspace bersama (dokumen, kode, catatan).', { path: str('Path relatif, mis. src/app.js'), content: str('Isi file lengkap') }, ['path', 'content']),
  ];
  if (ctx.depth < MAX_DEPTH && !ctx.noDelegate) {
    defs.push(
      fn('create_task', 'Delegasikan pekerjaan ke rekan tim sebagai kartu kanban baru. Rekan akan mengerjakannya otomatis, dan kamu dipanggil lagi untuk memeriksa hasilnya setelah semua subtugas selesai.', {
        assignee: str('id rekan tim (lihat daftar tim)'),
        title: str('Judul tugas singkat'),
        detail: str('Instruksi jelas: konteks, apa yang harus dihasilkan, format output'),
      }, ['assignee', 'title', 'detail']),
    );
  }
  if (ctx.chain.length < 3) {
    defs.push(fn('ask_agent', 'Tanya rekan tim secara langsung dan tunggu jawabannya (untuk pertanyaan singkat/pendapat, bukan pekerjaan besar).', { agent: str('id rekan tim'), question: str('Pertanyaan') }, ['agent', 'question']));
  }
  if (HTTP_TOOL) defs.push(fn('fetch_url', 'Ambil isi halaman web (teks) dari URL publik.', { url: str('URL http/https') }, ['url']));
  return defs;
}

async function execTool(name, args, agent, ctx, cfg) {
  switch (name) {
    case 'list_tasks': {
      const s = args.status || 'open';
      const tasks = board.allTasks().filter((t) => (s === 'open' ? board.OPEN.has(t.status) : t.status === s));
      return tasks.slice(-30).map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, createdBy: t.createdBy, parentId: t.parentId, result: truncate(t.result || '', 300) }));
    }

    case 'get_task': {
      const t = board.getTask(args.id);
      if (!t) return { error: `Kartu #${args.id} tidak ada` };
      return {
        ...t,
        result: truncate(t.result || '', 6000),
        children: board.children(t.id).map((c) => ({ id: c.id, title: c.title, status: c.status, assignee: c.assignee, result: truncate(c.result || '', 500) })),
      };
    }

    case 'create_task': {
      const target = findAgent(cfg, args.assignee);
      if (!target) return { error: `Agen "${args.assignee}" tidak dikenal. Pilihan: ${cfg.agents.map((a) => a.id).join(', ')}` };
      if (target.id === agent.id) return { error: 'Tidak bisa mendelegasikan ke dirimu sendiri. Kerjakan langsung.' };
      if (board.allTasks().filter((t) => board.OPEN.has(t.status)).length >= MAX_OPEN_TASKS) return { error: 'Papan kanban penuh, selesaikan tugas yang ada dulu.' };
      const parentId = ctx.taskId || ensureCoordTask(agent, ctx);
      const parent = board.getTask(parentId);
      if (parent?.createdBy === target.id) return { error: `${target.name} yang memberimu tugas ini; jangan delegasikan balik.` };
      const dupe = board.children(parentId).find((c) => c.assignee === target.id && c.title.trim().toLowerCase() === String(args.title || '').trim().toLowerCase());
      if (dupe) return { ok: true, taskId: dupe.id, message: `Kartu #${dupe.id} untuk ${target.name} sudah ada (status: ${dupe.status}). Tidak dibuat ulang.` };
      const t = board.createTask({ title: args.title, detail: args.detail, assignee: target.id, createdBy: agent.id, parentId, depth: (parent?.depth ?? 0) + 1 });
      emit({ type: 'handoff', from: agent.id, to: target.id, text: t.title, taskId: t.id });
      log(agent.id, `mendelegasikan #${t.id} "${t.title}" ke ${target.name}`, { taskId: t.id });
      return { ok: true, taskId: t.id, message: `Kartu #${t.id} dibuat untuk ${target.name} dan akan dikerjakan otomatis. Kamu akan dipanggil lagi setelah semua subtugas selesai.` };
    }

    case 'update_task': {
      const t = board.getTask(args.id);
      if (!t) return { error: `Kartu #${args.id} tidak ada` };
      if (t.assignee !== agent.id && t.createdBy !== agent.id) return { error: 'Kamu hanya boleh mengubah kartu milikmu atau yang kamu buat.' };
      if (args.note) board.addNote(t.id, agent.id, args.note);
      const patch = {};
      if (args.result) patch.result = String(args.result);
      if (args.status && board.STATUSES.includes(args.status)) {
        if (args.status === 'todo' && t.createdBy === agent.id && t.assignee !== agent.id) {
          if (t.revisions >= MAX_REVISIONS) return { error: `Kartu #${t.id} sudah direvisi ${t.revisions}x. Terima hasilnya atau kerjakan sendiri.` };
          patch.revisions = t.revisions + 1;
          emit({ type: 'handoff', from: agent.id, to: t.assignee, text: `revisi #${t.id}`, taskId: t.id });
          log(agent.id, `minta revisi #${t.id}: ${truncate(args.note || '', 120)}`, { taskId: t.id });
        }
        patch.status = args.status;
      }
      board.updateTask(t.id, patch);
      return { ok: true, id: t.id, status: board.getTask(t.id).status };
    }

    case 'ask_agent': {
      const target = findAgent(cfg, args.agent);
      if (!target) return { error: `Agen "${args.agent}" tidak dikenal. Pilihan: ${cfg.agents.map((a) => a.id).join(', ')}` };
      if (ctx.chain.includes(target.id)) return { error: `${target.name} sudah ada di rantai percakapan ini.` };
      emit({ type: 'handoff', from: agent.id, to: target.id, text: truncate(args.question, 80), ask: true });
      log(agent.id, `bertanya ke ${target.name}: ${truncate(args.question, 120)}`);
      const answer = await runAgent({
        agentId: target.id,
        messages: [{ role: 'user', content: `${agent.name} (${agent.role}) bertanya kepadamu:\n${args.question}\n\nJawab langsung dan ringkas (maks 150 kata).` }],
        ctx: { depth: ctx.depth + 1, chain: [...ctx.chain, target.id], noDelegate: true, signal: ctx.signal },
      });
      return { from: target.name, answer };
    }

    case 'list_files':
      return (await ws.listFiles()).slice(0, 100).map((f) => ({ path: f.path, size: f.size }));

    case 'read_file':
      return { path: args.path, content: await ws.readFile(args.path) };

    case 'write_file': {
      const r = await ws.writeFile(args.path, args.content);
      emit({ type: 'files' });
      log(agent.id, `menulis file ${r.path}`, { file: r.path });
      if (ctx.taskId) board.addNote(ctx.taskId, agent.id, `📄 ${r.path}`);
      return { ok: true, ...r };
    }

    case 'fetch_url': {
      if (!HTTP_TOOL) return { error: 'tool nonaktif' };
      const url = new URL(args.url);
      if (!/^https?:$/.test(url.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1)/.test(url.hostname)) return { error: 'URL tidak diizinkan' };
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'VirtualAIOffice/0.1' } });
      const text = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      log(agent.id, `membuka ${url.hostname}`);
      return { status: r.status, text: truncate(text, 8000) };
    }

    default:
      return { error: `tool "${name}" tidak dikenal` };
  }
}

// Chat biasa yang berujung delegasi dibungkus satu kartu "Koordinasi" milik agen itu.
function ensureCoordTask(agent, ctx) {
  if (ctx.coordId) return ctx.coordId;
  const t = board.createTask({
    title: `Koordinasi: ${truncate(ctx.userText || 'permintaan user', 80)}`,
    detail: ctx.userText || '',
    assignee: agent.id,
    createdBy: 'user',
    status: 'proses',
    origin: { type: 'chat', agentId: agent.id },
  });
  board.updateTask(t.id, { runs: 1 });
  ctx.coordId = t.id;
  return t.id;
}

// ---------- prompt ----------

function systemPrompt(agent, cfg, withTools) {
  const team = cfg.agents
    .filter((a) => a.id !== agent.id)
    .map((a) => {
      const st = lastStatus.get(a.id);
      const busy = st && st.status !== 'idle' ? ` (sedang ${st.text || st.status})` : '';
      return `- id "${a.id}": ${a.name}${a.role ? ` — ${a.role}` : ''}${busy}`;
    })
    .join('\n');
  const parts = [
    agent.systemPrompt,
    `## Tim\nKamu adalah ${agent.name}${agent.role ? ` (${agent.role})` : ''}, id "${agent.id}", di ${cfg.officeName || 'kantor ini'}. Rekan tim:\n${team || '(tidak ada)'}`,
    `## Papan kanban (tugas terbuka)\n${board.summarize()}`,
  ];
  if (withTools) {
    parts.push(`## Cara kerja tim
- Kamu bisa memanggil tools. Pakai hanya kalau memang membantu.
- Pekerjaan besar yang butuh keahlian rekan → create_task (satu tugas jelas per orang, boleh beberapa sekaligus supaya paralel). Pertanyaan singkat → ask_agent.
- Jangan delegasi ke dirimu sendiri atau balik ke pemberi tugas. Cek list_tasks kalau ragu supaya tidak duplikat.
- Hasil kerja panjang (dokumen, kode) simpan ke workspace dengan write_file, lalu sebutkan nama filenya.
- Setelah mendelegasikan, JANGAN menunggu: jawab singkat bahwa tugas sudah dibagi ke siapa saja. Kamu otomatis dipanggil lagi untuk memeriksa hasilnya.`);
  }
  parts.push('Jawab dalam Bahasa Indonesia.');
  return parts.filter(Boolean).join('\n\n');
}

function taskPrompt(t, finalize, cfg) {
  const nameOf = (id) => (id === 'user' ? 'user (atasan kalian)' : findAgent(cfg, id)?.name || id);
  const lines = [`Kamu mendapat tugas #${t.id} dari ${nameOf(t.createdBy)}: "${t.title}"`];
  if (t.detail) lines.push(`Detail:\n${t.detail}`);
  const parent = t.parentId && board.getTask(t.parentId);
  if (parent) lines.push(`Ini bagian dari tugas #${parent.id} "${parent.title}"${parent.detail ? `:\n${truncate(parent.detail, 800)}` : ''}`);
  const notes = t.notes.filter((n) => !n.text.startsWith('📄')).slice(-5);
  if (notes.length) lines.push(`Catatan/feedback:\n${notes.map((n) => `- ${nameOf(n.by)}: ${n.text}`).join('\n')}`);
  if (finalize) {
    const kids = board.children(t.id);
    lines.push(`Subtugas yang kamu delegasikan sudah selesai:\n${kids.map((c) => `### #${c.id} ${c.title} — ${nameOf(c.assignee)} [${c.status}]\n${truncate(c.result || '(tanpa hasil)', 1500)}`).join('\n\n')}`);
    lines.push(`Periksa hasilnya (baca file dengan read_file kalau perlu). Kalau ada yang belum memenuhi, minta revisi dengan update_task(id, status="todo", note="feedback spesifik"). Kalau sudah oke, tulis LAPORAN AKHIR yang menggabungkan semua hasil: ringkas, poin-poin, sebutkan file yang dibuat.`);
  } else {
    if (t.result && t.runs > 0) lines.push(`Hasil kerjamu sebelumnya (perbaiki sesuai feedback):\n${truncate(t.result, 1500)}`);
    lines.push('Kerjakan sekarang. Jawaban akhirmu akan ditempel di kartu kanban sebagai laporan hasil (ringkas, maks 200 kata; detail panjang simpan ke file).');
  }
  return lines.join('\n\n');
}

// ---------- loop agen ----------

// ctx: { depth, chain, taskId?, userText?, noDelegate?, signal?, onEvent? }
export async function runAgent({ agentId, messages, ctx }) {
  const cfg = await readConfig();
  const agent = findAgent(cfg, agentId);
  if (!agent) throw Object.assign(new Error('Agen tidak ditemukan'), { status: 404 });
  const provider = cfg.providers.find((p) => p.id === agent.providerId);
  if (!provider) throw Object.assign(new Error(`Provider "${agent.providerId}" tidak ada`), { status: 400 });
  const model = agent.model || provider.defaultModel;
  if (!model) throw Object.assign(new Error(`Model untuk ${agent.name} belum diisi (isi di Pengaturan)`), { status: 400 });

  ctx.chain ||= [agent.id];
  ctx.depth ||= 0;
  const withTools = toolsEnabled(provider);
  const tools = withTools ? toolDefs(ctx) : null;
  const msgs = [{ role: 'system', content: systemPrompt(agent, cfg, withTools) }, ...messages];
  const say = throttledSay(agent.id);

  activeRuns.set(agent.id, (activeRuns.get(agent.id) || 0) + 1);
  let final = '';
  try {
    for (let step = 0; step <= MAX_STEPS; step++) {
      const lastStep = step === MAX_STEPS;
      setStatus(agent.id, 'mikir', '', ctx.taskId);
      let typing = false;
      const res = await complete(provider, {
        model,
        messages: lastStep ? [...msgs, { role: 'user', content: 'Batas langkah tercapai. Tulis jawaban/laporan akhirmu sekarang tanpa memanggil tool.' }] : msgs,
        tools: lastStep ? null : tools,
        signal: ctx.signal,
        onText: (_d, full) => {
          if (!typing) setStatus(agent.id, 'ngetik', '', ctx.taskId);
          typing = true;
          const clean = stripThink(full);
          say(clean);
          ctx.onEvent?.({ type: 'delta', agentId: agent.id, text: clean });
        },
      });
      if (!res.toolCalls.length) {
        final = stripThink(res.content);
        break;
      }
      msgs.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
      for (const call of res.toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          /* argumen rusak → objek kosong */
        }
        setStatus(agent.id, 'tool', toolLabel(call.name, args, cfg), ctx.taskId);
        ctx.onEvent?.({ type: 'tool', agentId: agent.id, name: call.name, args: briefArgs(args) });
        let result;
        try {
          result = await execTool(call.name, args, agent, ctx, cfg);
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          result = { error: err.message };
        }
        ctx.onEvent?.({ type: 'tool_result', agentId: agent.id, name: call.name, ok: !result?.error, text: truncate(result?.error || result?.message || '', 200) });
        msgs.push({ role: 'tool', tool_call_id: call.id, content: truncate(JSON.stringify(result), 8000) });
      }
    }
    say(final);
    return final;
  } catch (err) {
    if (!ctx.signal?.aborted) setStatus(agent.id, 'error', truncate(err.message, 120), ctx.taskId);
    else say('');
    throw err;
  } finally {
    const n = (activeRuns.get(agent.id) || 1) - 1;
    activeRuns.set(agent.id, n);
    if (n <= 0 && lastStatus.get(agent.id)?.status !== 'error') setStatus(agent.id, 'idle');
  }
}

function toolLabel(name, args, cfg) {
  const who = (ref) => findAgent(cfg, ref)?.name || ref;
  return (
    {
      create_task: `delegasi ke ${who(args.assignee)}`,
      ask_agent: `tanya ${who(args.agent)}`,
      update_task: `update #${args.id}`,
      list_tasks: 'cek kanban',
      get_task: `baca kartu #${args.id}`,
      read_file: `baca ${args.path}`,
      write_file: `nulis ${args.path}`,
      list_files: 'cek berkas',
      fetch_url: 'browsing',
    }[name] || name
  );
}

function briefArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' ? truncate(v, k === 'content' ? 80 : 200) : v;
  return out;
}

// Dipanggil setelah agen selesai bekerja pada sebuah kartu (dari dispatcher atau chat).
export function afterRun(id, text) {
  const t = board.getTask(id);
  if (!t) return;
  const kids = board.children(id);
  if (kids.some((c) => ACTIVE.has(c.status))) {
    board.updateTask(id, { status: 'proses', waiting: true, result: t.result || text });
    return;
  }
  // Ada subtugas yang selesai setelah pemeriksaan terakhir → periksa lagi.
  if (kids.some((c) => (c.finishedAt || 0) > (t.reviewedAt || 0))) {
    board.updateTask(id, { status: 'todo', waiting: true, result: t.result || text });
    return;
  }
  const byAgent = t.createdBy !== 'user';
  const patch = { waiting: false, finishedAt: Date.now(), result: text || t.result };
  if (ACTIVE.has(t.status)) patch.status = byAgent ? 'review' : 'selesai';
  board.updateTask(id, patch);
  // subtugas yang sudah diperiksa induknya dianggap selesai
  for (const c of kids) if (c.status === 'review') board.updateTask(c.id, { status: 'selesai' });
  if (t.origin?.type === 'chat' && kids.length) emit({ type: 'report', agentId: t.assignee, taskId: t.id, title: t.title, text: board.getTask(id).result });
  notifyParent(board.getTask(id));
}

function notifyParent(t) {
  if (!t?.parentId) return;
  const p = board.getTask(t.parentId);
  if (!p?.waiting || p.status !== 'proses') return;
  if (board.children(p.id).every((c) => !ACTIVE.has(c.status))) board.updateTask(p.id, { status: 'todo' });
}

// Hentikan kartu beserta semua turunannya yang masih aktif.
export function stopTask(id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const c of board.children(ids[i])) ids.push(c.id);
  for (const tid of ids) {
    const t = board.getTask(tid);
    if (!t) continue;
    const running = runningTasks.get(tid);
    if (running) running.abort();
    else if (ACTIVE.has(t.status)) board.updateTask(tid, { status: 'gagal', waiting: false, result: t.result || 'Dihentikan oleh user.' });
  }
}

// ---------- dispatcher ----------

const runningTasks = new Map(); // taskId -> AbortController
const busyAgents = new Set();
let scheduled = false;

export function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    dispatch().catch((err) => console.error('[dispatch]', err));
  }, 50);
}

board.onBoardChange(schedule);

async function dispatch() {
  const cfg = await readConfig();
  if (cfg.autoRun === false) return;
  for (const t of board.allTasks()) {
    if (t.status !== 'todo' || !t.assignee || runningTasks.has(t.id) || busyAgents.has(t.assignee)) continue;
    if (!findAgent(cfg, t.assignee)) continue;
    if (t.runs >= MAX_RUNS) {
      board.updateTask(t.id, { status: 'gagal', result: t.result || 'Batas percobaan tercapai.' });
      continue;
    }
    runTask(t, cfg);
  }
}

export async function runTask(t, cfg) {
  const controller = new AbortController();
  runningTasks.set(t.id, controller);
  busyAgents.add(t.assignee);
  const kids = board.children(t.id);
  const finalize = kids.length > 0 && kids.every((c) => !ACTIVE.has(c.status));
  board.updateTask(t.id, { status: 'proses', waiting: false, runs: t.runs + 1, ...(finalize ? { reviewedAt: Date.now() } : {}) });
  log(t.assignee, finalize ? `memeriksa hasil subtugas #${t.id}` : `mulai mengerjakan #${t.id} "${t.title}"`, { taskId: t.id });
  try {
    const text = await runAgent({
      agentId: t.assignee,
      messages: [{ role: 'user', content: taskPrompt(board.getTask(t.id), finalize, cfg) }],
      // saat memeriksa hasil, agen hanya boleh menerima / minta revisi — bukan mendelegasikan ulang
      ctx: { depth: t.depth, taskId: t.id, chain: [t.assignee], noDelegate: finalize, signal: controller.signal },
    });
    afterRun(t.id, text);
    const after = board.getTask(t.id);
    if (after && !board.OPEN.has(after.status)) log(t.assignee, `menyelesaikan #${t.id}`, { taskId: t.id });
    else if (after?.status === 'review') log(t.assignee, `menyerahkan #${t.id} untuk direview`, { taskId: t.id });
    else if (after?.waiting) log(t.assignee, `menunggu subtugas #${t.id} selesai`, { taskId: t.id });
  } catch (err) {
    const stopped = controller.signal.aborted;
    if (board.getTask(t.id)) {
      board.updateTask(t.id, { status: 'gagal', waiting: false, finishedAt: Date.now(), result: stopped ? 'Dihentikan oleh user.' : `Error: ${err.message}` });
      log(t.assignee, stopped ? `berhenti mengerjakan #${t.id}` : `gagal di #${t.id}: ${truncate(err.message, 120)}`, { taskId: t.id, error: !stopped });
      if (!stopped) notifyParent(board.getTask(t.id));
    }
  } finally {
    runningTasks.delete(t.id);
    busyAgents.delete(t.assignee);
    schedule();
  }
}
