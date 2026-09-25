// Config kantor (provider & agen) yang disimpan di data/office.json.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'office.json');
const EXAMPLE_PATH = path.join(DATA_DIR, 'office.example.json');

let cache = null;

export async function readConfig() {
  if (cache) return cache;
  if (!fs.existsSync(CONFIG_PATH)) await fsp.copyFile(EXAMPLE_PATH, CONFIG_PATH);
  cache = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  return cache;
}

export async function writeConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fsp.rename(tmp, CONFIG_PATH);
  cache = cfg;
}

export function providerKey(p) {
  return p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] : '') || '';
}

// Versi config yang aman dikirim ke browser (tanpa API key).
export function publicConfig(cfg) {
  return {
    ...cfg,
    autoRun: cfg.autoRun !== false,
    httpTool: process.env.TOOLS_HTTP === '1',
    providers: cfg.providers.map(({ apiKey, ...p }) => ({ ...p, tools: p.tools !== false, hasKey: Boolean(providerKey({ apiKey, ...p })) })),
  };
}

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

// Gabungkan config dari UI dengan yang tersimpan; apiKey kosong = pertahankan yang lama.
export function mergeConfig(current, incoming) {
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
      tools: p.tools !== false && p.tools !== 'false',
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
  return {
    ...current,
    officeName: String(incoming.officeName || current.officeName || 'Kantor AI'),
    autoRun: incoming.autoRun === undefined ? current.autoRun !== false : Boolean(incoming.autoRun),
    providers,
    agents,
  };
}

export function findAgent(cfg, ref) {
  const r = String(ref || '').trim().replace(/^@/, '').toLowerCase();
  return cfg.agents.find((a) => a.id.toLowerCase() === r) || cfg.agents.find((a) => a.name.toLowerCase() === r) || cfg.agents.find((a) => a.tag && a.tag.toLowerCase() === r);
}
