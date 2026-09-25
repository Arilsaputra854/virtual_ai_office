// Dialog pengaturan provider & agen.
import { saveConfig, listModels } from './api.js';

const $ = (sel, root = document) => root.querySelector(sel);
const COLORS = ['#ec4899', '#3b82f6', '#14b8a6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];

function field(label, name, value = '', attrs = '') {
  const id = 'f' + Math.random().toString(36).slice(2, 9);
  return `<label for="${id}">${label}<input id="${id}" name="${name}" ${attrs}></label>`.replace('<input', `<input value="${attr(value)}"`);
}

function attr(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function providerCard(p = {}) {
  const el = document.createElement('fieldset');
  el.className = 'card';
  el.dataset.id = p.id || '';
  el.innerHTML = `
    <div class="grid">
      ${field('Nama', 'name', p.name, 'required placeholder="mis. OpenRouter"')}
      ${field('Base URL', 'baseUrl', p.baseUrl, 'required placeholder="https://api.openai.com/v1"')}
      ${field('API key', 'apiKey', '', `type="password" autocomplete="off" placeholder="${p.hasKey ? '•••••• (tersimpan)' : 'kosong / tidak perlu'}"`)}
      ${field('Env API key', 'apiKeyEnv', p.apiKeyEnv, 'placeholder="OPENAI_API_KEY"')}
      <label>Model default
        <span class="row"><input name="defaultModel" list="models-${attr(p.id || 'new')}" value="${attr(p.defaultModel)}" placeholder="gpt-4o-mini"><button type="button" class="btn small" data-act="models">Ambil model</button></span>
        <datalist id="models-${attr(p.id || 'new')}"></datalist>
      </label>
      <label class="check"><input type="checkbox" name="tools" ${p.tools === false ? '' : 'checked'}> Tool calling (delegasi, kanban, file)</label>
    </div>
    <div class="card-foot"><small class="status"></small><button type="button" class="btn small danger" data-act="remove">Hapus</button></div>`;
  $('[data-act=remove]', el).onclick = () => el.remove();
  $('[data-act=models]', el).onclick = async () => {
    const status = $('.status', el);
    if (!el.dataset.id) return (status.textContent = 'Simpan dulu provider baru, lalu ambil model.');
    status.textContent = 'Mengambil daftar model…';
    try {
      const { models } = await listModels(el.dataset.id);
      fillModelLists(el.dataset.id, models);
      status.textContent = `✓ Terhubung — ${models.length} model tersedia.`;
    } catch (err) {
      status.textContent = '⚠️ ' + err.message;
    }
  };
  return el;
}

function agentCard(a, providers) {
  const el = document.createElement('fieldset');
  el.className = 'card';
  el.dataset.id = a.id || '';
  const opts = providers.map((p) => `<option value="${attr(p.id)}" ${p.id === a.providerId ? 'selected' : ''}>${attr(p.name)}</option>`).join('');
  el.innerHTML = `
    <div class="grid">
      ${field('Nama', 'name', a.name, 'required')}
      ${field('Singkatan', 'tag', a.tag, 'maxlength="4" placeholder="PM"')}
      ${field('Peran', 'role', a.role, 'placeholder="Product Manager"')}
      <label>Warna<input type="color" name="color" value="${attr(a.color || COLORS[0])}"></label>
      <label>Provider<select name="providerId">${opts}</select></label>
      <label>Model <input name="model" list="models-${attr(a.providerId)}" value="${attr(a.model)}" placeholder="(pakai default provider)"></label>
    </div>
    <label>System prompt / kepribadian<textarea name="systemPrompt" rows="3">${attr(a.systemPrompt)}</textarea></label>
    <div class="card-foot"><span></span><button type="button" class="btn small danger" data-act="remove">Hapus</button></div>`;
  $('[data-act=remove]', el).onclick = () => el.remove();
  $('select', el).onchange = (e) => $('[name=model]', el).setAttribute('list', 'models-' + e.target.value);
  return el;
}

function fillModelLists(providerId, models) {
  for (const dl of document.querySelectorAll(`datalist[id="models-${CSS.escape(providerId)}"]`)) {
    dl.innerHTML = models.map((m) => `<option value="${attr(m)}">`).join('');
  }
}

function readCard(el) {
  const out = { id: el.dataset.id || undefined };
  for (const input of el.querySelectorAll('[name]')) out[input.name] = input.type === 'checkbox' ? input.checked : input.value.trim();
  return out;
}

export function openSettings(config, onSaved) {
  const dlg = $('#dlg-settings');
  const form = $('#form-settings');
  $('#set-office-name').value = config.officeName || '';
  $('#set-autorun').checked = config.autoRun !== false;
  const provBox = $('#set-providers');
  const agentBox = $('#set-agents');
  provBox.replaceChildren(...config.providers.map(providerCard));
  agentBox.replaceChildren(...config.agents.map((a) => agentCard(a, config.providers)));

  $('#btn-add-provider').onclick = () => provBox.appendChild(providerCard({}));
  $('#btn-add-agent').onclick = () => {
    const n = agentBox.children.length;
    const card = agentCard({ name: '', color: COLORS[n % COLORS.length], providerId: config.providers[0]?.id }, config.providers);
    agentBox.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('[name=name]', card).focus();
  };

  form.onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const providers = [...provBox.querySelectorAll('fieldset.card')].map(readCard);
    const agents = [...agentBox.querySelectorAll('fieldset.card')].map(readCard);
    const usedIds = new Set();
    for (const a of agents) {
      let id = a.id || a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agen';
      const base = id;
      for (let i = 2; usedIds.has(id); i++) id = `${base}-${i}`;
      usedIds.add((a.id = id));
    }
    if (!agents.length) return alert('Minimal harus ada 1 agen.');
    if (agents.length > 9) return alert('Maksimal 9 agen (jumlah meja di kantor).');
    try {
      await saveConfig({ officeName: $('#set-office-name').value.trim(), autoRun: $('#set-autorun').checked, providers, agents });
      dlg.close();
      onSaved();
    } catch (err) {
      alert('Gagal menyimpan: ' + err.message);
    }
  };
  dlg.showModal();
}
