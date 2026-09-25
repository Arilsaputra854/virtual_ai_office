// Tes end-to-end: server asli + mock LLM. Jalankan dengan `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let mock;
let base;
let dataDir;
const procs = [];

function startServer(args = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DATA_DIR: dataDir, OFFICE_PASSWORD: '', HOST: '127.0.0.1', PORT: '' };
    const proc = spawn(process.execPath, ['server.js', ...args], { cwd: ROOT, env });
    procs.push(proc);
    let out = '';
    const onData = (d) => {
      out += d;
      const m = out.match(/jalan di (http:\/\/[^\s]+)/);
      if (m) resolve({ proc, url: m[1], out: () => out });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`server keluar (${code}): ${out}`)));
  });
}

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  return res.headers.get('content-type')?.includes('json') ? { status: res.status, data: await res.json() } : { status: res.status, text: await res.text() };
};

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout menunggu kondisi');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function chat(agentId, content) {
  const res = await fetch(base + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, messages: [{ role: 'user', content }] }) });
  const events = (await res.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return { events, done: events.find((e) => e.type === 'done'), error: events.find((e) => e.type === 'error') };
}

before(async () => {
  mock = await startMockLlm();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vao-test-'));
  const agent = (id, name, providerId = 'mock') => ({ id, name, role: 'tes', color: '#3b82f6', providerId, model: '', systemPrompt: '' });
  fs.writeFileSync(
    path.join(dataDir, 'office.json'),
    JSON.stringify({
      officeName: 'Tes',
      providers: [
        { id: 'mock', name: 'Mock', baseUrl: mock.url + '/v1', defaultModel: 'mock-1' },
        { id: 'notools', name: 'NoTools', baseUrl: mock.url + '/notools/v1', defaultModel: 'mock-1' },
      ],
      agents: [agent('rani', 'Rani'), agent('gilang', 'Gilang'), agent('dinda', 'Dinda'), agent('budi', 'Budi', 'notools')],
    }),
  );
  base = (await startServer(['--port', '0'])).url;
});

after(() => {
  for (const p of procs) p.kill();
  mock?.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('koordinasi: delegasi → kerja paralel → review → laporan akhir', async () => {
  const { done, events } = await chat('rani', 'Tolong koordinasi tim bikin fitur login');
  assert.ok(done, 'chat harus selesai');
  assert.equal(events.filter((e) => e.type === 'tool' && e.name === 'create_task').length, 2);
  const coordId = done.taskId;
  assert.ok(coordId, 'chat yang mendelegasikan membuat kartu koordinasi');

  const tasks = await waitFor(async () => {
    const { data } = await api('/api/tasks');
    return data.tasks.find((t) => t.id === coordId)?.status === 'selesai' && data.tasks;
  });
  const coord = tasks.find((t) => t.id === coordId);
  const kids = tasks.filter((t) => t.parentId === coordId);
  assert.match(coord.result, /LAPORAN AKHIR/);
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.status === 'selesai'), 'subtugas pindah ke selesai setelah direview');

  const { data } = await api('/api/files');
  assert.ok(data.files.some((f) => f.path === 'api/login.md'), 'Gilang menulis file ke workspace');
  const raw = await api('/api/files/raw?path=api/login.md');
  assert.match(raw.text, /API login/);
});

test('kartu yang sedang dikerjakan bisa dihentikan', async () => {
  const { data: t } = await api('/api/tasks', { method: 'POST', body: { title: 'Tugas lambat', assignee: 'gilang' } });
  await waitFor(async () => (await api('/api/tasks')).data.tasks.find((x) => x.id === t.id)?.status === 'proses');
  await api(`/api/tasks/${t.id}/stop`, { method: 'POST' });
  const stopped = await waitFor(async () => {
    const x = (await api('/api/tasks')).data.tasks.find((y) => y.id === t.id);
    return x.status === 'gagal' && x;
  });
  assert.match(stopped.result, /Dihentikan/);
});

test('provider tanpa dukungan tools otomatis jalan tanpa tools', async () => {
  const { done, error } = await chat('budi', 'halo');
  assert.equal(error, undefined);
  assert.match(done.text, /Halo dari Budi/);
});

test('HTTP 429 dari provider di-retry otomatis', async () => {
  const { done, error } = await chat('rani', 'tes flaky');
  assert.equal(error, undefined);
  assert.match(done.text, /Halo dari Rani/);
});

test('path di luar workspace ditolak', async () => {
  const r = await api('/api/files/raw?path=' + encodeURIComponent('../office.json'));
  assert.equal(r.status, 403);
});

test('port bentrok → pindah ke port berikutnya', async () => {
  const port = Number(new URL(base).port);
  const second = await startServer(['--port', String(port)]);
  assert.notEqual(Number(new URL(second.url).port), port);
  assert.match(second.out(), /sudah dipakai/);
  second.proc.kill();
});
