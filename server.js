// Virtual AI Office — server ringan tanpa framework.
// - Menyajikan frontend statis (public/) dan three.js dari node_modules.
// - Proxy ke API OpenAI-compatible (9router, OpenAI, OpenRouter, Ollama, dll)
//   supaya API key tidak pernah sampai ke browser dan tidak kena CORS.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, '.env'));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.OFFICE_PASSWORD || '';
const CONFIG_PATH = path.join(ROOT, 'data', 'office.json');
const EXAMPLE_PATH = path.join(ROOT, 'data', 'office.example.json');
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

// ---------- Config ----------

async function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) await fsp.copyFile(EXAMPLE_PATH, CONFIG_PATH);
  return JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
}

async function writeConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fsp.rename(tmp, CONFIG_PATH);
}

function providerKey(p) {
  return p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] : '') || '';
}

// Versi config yang aman dikirim ke browser (tanpa API key).
function publicConfig(cfg) {
  return {
    ...cfg,
    providers: cfg.providers.map(({ apiKey, ...p }) => ({ ...p, hasKey: Boolean(providerKey({ apiKey, ...p })) })),
  };
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

// Gabungkan config dari UI dengan yang tersimpan; apiKey kosong = pertahankan yang lama.
function mergeConfig(current, incoming) {
  const oldProviders = new Map(current.providers.map((p) => [p.id, p]));
  const providers = (incoming.providers || []).map((p) => {
    const id = p.id || slug(p.name);
    const old = oldProviders.get(id) || {};
    const out = {
      id,
      name: String(p.name || id),
      baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
      apiKeyEnv: String(p.apiKeyEnv || ''),
      defaultModel: String(p.defaultModel || ''),
    };
    const key = p.apiKey === undefined || p.apiKey === '' ? old.apiKey : p.apiKey;
    if (key && key !== '__clear__') out.apiKey = key;
    return out;
  });
  const agents = (incoming.agents || []).map((a) => ({
    id: a.id || slug(a.name),
    name: String(a.name || 'Agen'),
    tag: String(a.tag || '').slice(0, 4),
    role: String(a.role || ''),
    color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#64748b',
    providerId: String(a.providerId || providers[0]?.id || ''),
    model: String(a.model || ''),
    systemPrompt: String(a.systemPrompt || ''),
  }));
  return { ...current, officeName: String(incoming.officeName || current.officeName || 'Kantor AI'), providers, agents };
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

// ---------- LLM proxy ----------

async function upstream(provider, endpoint, init = {}) {
  if (!provider?.baseUrl) throw Object.assign(new Error('Provider belum diatur (baseUrl kosong)'), { status: 400 });
  const key = providerKey(provider);
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  return fetch(provider.baseUrl.replace(/\/+$/, '') + endpoint, { ...init, headers });
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const cfg = await readConfig();
  const agent = cfg.agents.find((a) => a.id === body.agentId);
  if (!agent) return sendJson(res, 404, { error: 'Agen tidak ditemukan' });
  const provider = cfg.providers.find((p) => p.id === agent.providerId);
  if (!provider) return sendJson(res, 400, { error: `Provider "${agent.providerId}" tidak ada` });
  const model = agent.model || provider.defaultModel;
  if (!model) return sendJson(res, 400, { error: `Model untuk ${agent.name} belum diisi (isi di Pengaturan)` });

  const messages = [
    ...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []),
    ...(Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => ['user', 'assistant', 'system'].includes(m?.role) && typeof m.content === 'string')
      .slice(-40),
  ];

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let r;
  try {
    r = await upstream(provider, '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model, messages, stream: true, ...(body.temperature != null ? { temperature: body.temperature } : {}) }),
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

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Virtual AI Office"' });
      return res.end('Butuh password');
    }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/api/config' && req.method === 'GET') return sendJson(res, 200, publicConfig(await readConfig()));
    if (p === '/api/config' && req.method === 'PUT') {
      const merged = mergeConfig(await readConfig(), await readBody(req));
      await writeConfig(merged);
      return sendJson(res, 200, publicConfig(merged));
    }
    if (p === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (p === '/api/models' && req.method === 'GET') return await handleModels(res, url.searchParams.get('provider'));
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Endpoint tidak ada' });

    if (p.startsWith('/vendor/three/')) {
      const file = safeJoin(THREE_DIR, p.slice('/vendor/three/'.length));
      return file ? serveFile(res, file) : sendJson(res, 403, { error: 'Dilarang' });
    }
    const file = safeJoin(PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
    return file ? serveFile(res, file) : sendJson(res, 403, { error: 'Dilarang' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🏢 Virtual AI Office jalan di http://${HOST}:${PORT}`);
});
