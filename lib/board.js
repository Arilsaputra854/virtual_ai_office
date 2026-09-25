// Papan kanban bersama: disimpan di data/board.json dan disiarkan lewat bus.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { emit } from './bus.js';

const BOARD_PATH = path.join(DATA_DIR, 'board.json');
export const STATUSES = ['todo', 'proses', 'review', 'selesai', 'gagal'];
export const OPEN = new Set(['todo', 'proses', 'review']);

let state = { nextId: 1, tasks: [] };
if (fs.existsSync(BOARD_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
    // Tugas yang sedang berjalan saat server mati dikembalikan ke antrean.
    for (const t of state.tasks) if (t.status === 'proses' && !t.waiting) t.status = 'todo';
  } catch {
    /* file rusak: mulai kosong */
  }
}

let saveTimer = null;
function changed() {
  emit({ type: 'board', tasks: state.tasks });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fsp.writeFile(BOARD_PATH, JSON.stringify(state, null, 2)).catch(() => {}), 300);
  for (const fn of watchers) fn();
}

const watchers = new Set();
export function onBoardChange(fn) {
  watchers.add(fn);
}

export function allTasks() {
  return state.tasks;
}

export function getTask(id) {
  return state.tasks.find((t) => t.id === Number(String(id).replace('#', '')));
}

export function children(id) {
  return state.tasks.filter((t) => t.parentId === id);
}

export function createTask({ title, detail = '', assignee = null, createdBy = 'user', parentId = null, depth = 0, status = 'todo', origin = null }) {
  const now = Date.now();
  const task = {
    id: state.nextId++,
    title: String(title || 'Tanpa judul').slice(0, 140),
    detail: String(detail || '').slice(0, 4000),
    assignee,
    createdBy,
    parentId,
    depth,
    status: STATUSES.includes(status) ? status : 'todo',
    result: '',
    notes: [],
    runs: 0,
    revisions: 0,
    origin,
    createdAt: now,
    updatedAt: now,
  };
  state.tasks.push(task);
  changed();
  return task;
}

export function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) return null;
  if (patch.status && !STATUSES.includes(patch.status)) delete patch.status;
  Object.assign(t, patch, { updatedAt: Date.now() });
  if (t.notes.length > 30) t.notes = t.notes.slice(-30);
  changed();
  return t;
}

export function addNote(id, by, text) {
  const t = getTask(id);
  if (!t) return;
  t.notes.push({ by, text: String(text).slice(0, 1000), at: Date.now() });
  t.updatedAt = Date.now();
  changed();
}

export function deleteTask(id) {
  const ids = new Set([Number(id)]);
  // hapus juga turunannya
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of state.tasks) if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) ids.add(t.id), (grew = true);
  }
  state.tasks = state.tasks.filter((t) => !ids.has(t.id));
  changed();
}

export function clearDone() {
  const keep = new Set();
  for (const t of state.tasks) if (OPEN.has(t.status)) for (let p = t; p; p = p.parentId && getTask(p.parentId)) keep.add(p.id);
  state.tasks = state.tasks.filter((t) => keep.has(t.id));
  changed();
}

export function summarize(limit = 15) {
  const open = state.tasks.filter((t) => OPEN.has(t.status)).slice(-limit);
  if (!open.length) return '(papan kosong)';
  return open.map((t) => `#${t.id} [${t.status}${t.waiting ? ', menunggu subtugas' : ''}] ${t.title} → ${t.assignee || '-'}`).join('\n');
}
