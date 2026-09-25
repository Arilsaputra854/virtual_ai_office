// Klien API ke server lokal (yang meneruskan ke provider OpenAI-compatible).

async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const getConfig = () => fetch('/api/config').then(json);

export const saveConfig = (cfg) =>
  fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).then(json);

export const listModels = (providerId) => fetch(`/api/models?provider=${encodeURIComponent(providerId)}`).then(json);

// Kirim chat ke agen dan baca respons streaming (SSE). onDelta(teksBaru, teksLengkap).
export async function streamChat(agentId, messages, { onDelta, signal } = {}) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, messages }),
    signal,
  });
  if (!res.ok) await json(res);

  // Beberapa provider mengabaikan stream:true dan membalas JSON biasa.
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    onDelta?.(text, text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const chunk = JSON.parse(payload);
        if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
        const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
        if (delta) {
          full += delta;
          onDelta?.(delta, full);
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
  return full;
}

// Parser SSE generik: memanggil onEvent(obj) untuk tiap baris "data: {...}".
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        onEvent(JSON.parse(line.slice(5)));
      } catch {
        /* abaikan baris rusak */
      }
    }
  }
}

// Chat dengan agen yang bisa memakai tools (delegasi, kanban, file).
// onEvent menerima {type: 'delta'|'tool'|'tool_result'}; resolve dengan teks akhir.
export async function runAgent(agentId, messages, { onEvent, signal } = {}) {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, messages }),
    signal,
  });
  if (!res.ok) await json(res);
  let final = null;
  let error = null;
  await readSse(res, (ev) => {
    if (ev.type === 'done') final = ev;
    else if (ev.type === 'error') error = ev.error;
    else onEvent?.(ev);
  });
  if (error) throw Object.assign(new Error(error), error === 'dibatalkan' ? { name: 'AbortError' } : {});
  if (!final) throw new Error('Koneksi terputus');
  return final;
}

// Event live dari server (status agen, kanban, handoff, log, laporan).
export function subscribe(onEvent) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* abaikan */
    }
  };
  return es;
}

export const tasks = {
  create: (task) => fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task) }).then(json),
  update: (id, patch) => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
  remove: (id) => fetch(`/api/tasks/${id}`, { method: 'DELETE' }).then(json),
  stop: (id) => fetch(`/api/tasks/${id}/stop`, { method: 'POST' }).then(json),
  clearDone: () => fetch('/api/tasks/clear-done', { method: 'POST' }).then(json),
};

export const files = {
  list: () => fetch('/api/files').then(json),
  read: (path) => fetch(`/api/files?path=${encodeURIComponent(path)}`).then(json),
  downloadUrl: (path) => `/api/files/raw?path=${encodeURIComponent(path)}`,
};
