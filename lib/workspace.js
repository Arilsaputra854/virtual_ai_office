// Folder kerja bersama (data/workspace) yang bisa dibaca/ditulis agen lewat tools.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const WORKSPACE = path.join(DATA_DIR, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

const MAX_FILE = 200_000;

function resolve(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) throw new Error('path kosong');
  const full = path.normalize(path.join(WORKSPACE, clean));
  if (!full.startsWith(WORKSPACE + path.sep)) throw new Error('path di luar workspace');
  return full;
}

export async function listFiles() {
  const out = [];
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const st = await fsp.stat(full);
        out.push({ path: path.relative(WORKSPACE, full).split(path.sep).join('/'), size: st.size, updatedAt: st.mtimeMs });
      }
      if (out.length > 500) return;
    }
  };
  await walk(WORKSPACE);
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readFile(rel) {
  const full = resolve(rel);
  const st = await fsp.stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(`file "${rel}" tidak ada`);
  const text = await fsp.readFile(full, 'utf8');
  return text.length > MAX_FILE ? text.slice(0, MAX_FILE) + '\n…(dipotong)' : text;
}

export async function writeFile(rel, content) {
  const full = resolve(rel);
  const text = String(content ?? '');
  if (text.length > MAX_FILE) throw new Error('isi file terlalu besar');
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, text);
  return { path: path.relative(WORKSPACE, full).split(path.sep).join('/'), bytes: Buffer.byteLength(text) };
}
