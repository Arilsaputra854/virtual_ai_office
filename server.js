// Virtual AI Office — server ringan tanpa framework.
// - Menyajikan frontend statis (public/) dan three.js dari node_modules.
// - Proxy ke API OpenAI-compatible (9router, OpenAI, OpenRouter, Ollama, dll)
//   supaya API key tidak pernah sampai ke browser dan tidak kena CORS.
// - Menjalankan agen dengan tool calling + papan kanban bersama (lib/).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, '.env'));

// Modul lib dibaca setelah .env dimuat (beberapa membaca process.env saat import).
const { readConfig, writeConfig, publicConfig, mergeConfig, findAgent } = await import('./lib/config.js');
const { upstream } = await import('./lib/llm.js');
const bus = await import('./lib/bus.js');
const board = await import('./lib/board.js');
const agents = await import('./lib/agents.js');
const ws = await import('./lib/workspace.js');

// Prioritas: argumen CLI (--port 8080 / --host 0.0.0.0) > .env > default.
function cliArg(name) {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return process.argv[i].includes('=') ? process.argv[i].split('=')[1] : process.argv[i + 1];
}
const HOST = cliArg('host') || process.env.HOST || '127.0.0.1';
const PORT = Number(cliArg('port') ?? process.env.PORT ?? 3000);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Port tidak valid: ${cliArg('port') ?? process.env.PORT}`);
  process.exit(1);
}
const PASSWORD = process.env.OFFICE_PASSWORD || '';
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------- HTTP helpers ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body terlalu besar'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error('JSON tidak valid'), { status: 400 });
  }
}

function authorized(req) {
  if (!PASSWORD) return true;
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
  return pass === PASSWORD;
}

async function serveFile(res, file) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': file.startsWith(THREE_DIR) ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Tidak ditemukan' });
  }
}

function safeJoin(base, rel) {
  const full = path.normalize(path.join(base, decodeURIComponent(rel)));
  return full.startsWith(base + path.sep) || full === base ? full : null;
}

function cleanMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string' && m.content)
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.content }));
}

// ---------- LLM ----------

// Chat polos tanpa tools (dipakai untuk giliran bicara saat rapat).
async function handleChat(req, res) {
  const body = await readBody(req);
  const cfg = await readConfig();
  const agent = findAgent(cfg, body.agentId);
  if (!agent) return sendJson(res, 404, { error: 'Agen tidak ditemukan' });
  const provider = cfg.providers.find((p) => p.id === agent.providerId);
  if (!provider) return sendJson(res, 400, { error: `Provider "${agent.providerId}" tidak ada` });
  const model = agent.model || provider.defaultModel;
  if (!model) return sendJson(res, 400, { error: `Model untuk ${agent.name} belum diisi (isi di Pengaturan)` });

  const messages = [...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []), ...cleanMessages(body.messages)];
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let r;
  try {
    r = await upstream(provider, '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model, messages, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    return sendJson(res, 502, { error: `Gagal konek ke ${provider.name}: ${err.cause?.code || err.message}` });
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return sendJson(res, r.status, { error: `${provider.name} (${r.status}): ${text.slice(0, 500)}` });
  }
  res.writeHead(200, {
    'Content-Type': r.headers.get('content-type') || 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
}

// Chat dengan agen yang bisa memakai tools. Balasan berupa SSE event:
// delta | tool | tool_result | done | error
async function handleAgentRun(req, res) {
  const body = await readBody(req);
  const messages = cleanMessages(body.messages);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (ev) => !res.writableEnded && res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ctx = {
    depth: 0,
    signal: controller.signal,
    userText: [...messages].reverse().find((m) => m.role === 'user')?.content || '',
    onEvent: send,
  };
  try {
    const text = await agents.runAgent({ agentId: body.agentId, messages, ctx });
    if (ctx.coordId) agents.afterRun(ctx.coordId, text);
    send({ type: 'done', text, taskId: ctx.coordId || null });
  } catch (err) {
    if (ctx.coordId) board.updateTask(ctx.coordId, { status: 'gagal', result: `Error: ${err.message}` });
    send({ type: 'error', error: err.name === 'AbortError' ? 'dibatalkan' : err.message });
  }
  res.end();
}

async function handleModels(res, providerId) {
  const cfg = await readConfig();
  const provider = cfg.providers.find((p) => p.id === providerId);
  if (!provider) return sendJson(res, 404, { error: 'Provider tidak ditemukan' });
  try {
    const r = await upstream(provider, '/models');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return sendJson(res, r.status, { error: data?.error?.message || `HTTP ${r.status}` });
    const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
    sendJson(res, 200, { models });
  } catch (err) {
    sendJson(res, 502, { error: `Gagal konek: ${err.cause?.code || err.message}` });
  }
}

// ---------- Router ----------

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/config' && m === 'GET') return sendJson(res, 200, publicConfig(await readConfig()));
  if (p === '/api/config' && m === 'PUT') {
    const merged = mergeConfig(await readConfig(), await readBody(req));
    await writeConfig(merged);
    agents.schedule();
    return sendJson(res, 200, publicConfig(merged));
  }
  if (p === '/api/models' && m === 'GET') return handleModels(res, url.searchParams.get('provider'));
  if (p === '/api/chat' && m === 'POST') return handleChat(req, res);
  if (p === '/api/agent' && m === 'POST') return handleAgentRun(req, res);

  if (p === '/api/events' && m === 'GET') {
    return bus.attachClient(req, res, [{ type: 'board', tasks: board.allTasks() }, ...agents.statusSnapshot()]);
  }

  // Kanban
  if (p === '/api/tasks' && m === 'GET') return sendJson(res, 200, { tasks: board.allTasks() });
  if (p === '/api/tasks' && m === 'POST') {
    const body = await readBody(req);
    const cfg = await readConfig();
    const assignee = body.assignee ? findAgent(cfg, body.assignee)?.id : null;
    if (!String(body.title || '').trim()) return sendJson(res, 400, { error: 'Judul wajib diisi' });
    return sendJson(res, 200, board.createTask({ title: body.title, detail: body.detail, assignee, createdBy: 'user' }));
  }
  if (p === '/api/tasks/clear-done' && m === 'POST') {
    board.clearDone();
    return sendJson(res, 200, { ok: true });
  }
  const stop = p.match(/^\/api\/tasks\/(\d+)\/stop$/);
  if (stop && m === 'POST') {
    agents.stopTask(Number(stop[1]));
    return sendJson(res, 200, { ok: true });
  }
  const tm = p.match(/^\/api\/tasks\/(\d+)$/);
  if (tm && m === 'PATCH') {
    const body = await readBody(req);
    const patch = {};
    if (body.status) patch.status = body.status;
    if (body.status === 'todo') Object.assign(patch, { waiting: false, runs: 0 });
    if (body.assignee !== undefined) patch.assignee = findAgent(await readConfig(), body.assignee)?.id || null;
    if (body.title) patch.title = String(body.title).slice(0, 140);
    if (body.detail !== undefined) patch.detail = String(body.detail).slice(0, 4000);
    const t = board.updateTask(tm[1], patch);
    if (body.note) board.addNote(tm[1], 'user', body.note);
    return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: 'Kartu tidak ada' });
  }
  if (tm && m === 'DELETE') {
    agents.stopTask(Number(tm[1]));
    board.deleteTask(tm[1]);
    return sendJson(res, 200, { ok: true });
  }

  // Workspace
  if (p === '/api/files/raw' && m === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const full = safeJoin(ws.WORKSPACE, rel);
    if (!full) return sendJson(res, 403, { error: 'Dilarang' });
    const name = path.basename(full).replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return serveFile(res, full);
  }
  if (p === '/api/files' && m === 'GET') {
    const file = url.searchParams.get('path');
    if (!file) return sendJson(res, 200, { files: await ws.listFiles() });
    try {
      return sendJson(res, 200, { path: file, content: await ws.readFile(file) });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Endpoint tidak ada' });

  if (p.startsWith('/vendor/three/')) {
    const file = safeJoin(THREE_DIR, p.slice('/vendor/three/'.length));
    return file ? serveFile(res, file) : sendJson(res, 403, { error: 'Dilarang' });
  }
  const file = safeJoin(PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
  return file ? serveFile(res, file) : sendJson(res, 403, { error: 'Dilarang' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Virtual AI Office"' });
      return res.end('Butuh password');
    }
    await route(req, res, new URL(req.url, 'http://x'));
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.end();
  }
});

// Kalau port sudah dipakai, coba port berikutnya (maks 10x).
function listen(port, attempt = 0) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10 && port !== 0) {
      console.warn(`⚠️  Port ${port} sudah dipakai, mencoba ${port + 1}…`);
      return listen(port + 1, attempt + 1);
    }
    if (err.code === 'EACCES') console.error(`❌ Tidak punya izin memakai port ${port} (port di bawah 1024 butuh root). Coba: npm start -- --port 8080`);
    else console.error(`❌ Gagal menjalankan server: ${err.message}`);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.off('error', onError);
    const actual = server.address().port;
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    console.log(`🏢 Virtual AI Office jalan di http://${shown}:${actual}`);
    if (shown === 'localhost') console.log('   (bisa diakses dari perangkat lain di jaringan yang sama lewat IP komputer ini)');
    if (shown === 'localhost' && !PASSWORD) console.warn('⚠️  Server terbuka ke jaringan tanpa OFFICE_PASSWORD — siapa pun di jaringan bisa memakai kuota API kamu.');
    agents.schedule(); // lanjutkan tugas yang tertunda
  });
}
listen(PORT);
