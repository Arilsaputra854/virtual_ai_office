// Panggilan ke API OpenAI-compatible: streaming teks + tool calls.
import { providerKey } from './config.js';

const noToolsProviders = new Set(); // provider yang ternyata menolak parameter tools

export function upstream(provider, endpoint, init = {}) {
  if (!provider?.baseUrl) throw Object.assign(new Error('Provider belum diatur (baseUrl kosong)'), { status: 400 });
  const key = providerKey(provider);
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  return fetch(provider.baseUrl.replace(/\/+$/, '') + endpoint, { ...init, headers });
}

export function toolsEnabled(provider) {
  return provider.tools !== false && !noToolsProviders.has(provider.id);
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const IDLE_TIMEOUT_MS = Number(process.env.LLM_IDLE_TIMEOUT_MS || 120_000);
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

// Satu langkah chat completion (streaming). Mengembalikan { content, toolCalls }.
// Otomatis retry untuk 429/5xx/putus koneksi, dan batal kalau provider diam > IDLE_TIMEOUT_MS.
export async function complete(provider, { model, messages, tools, signal, onText }) {
  const useTools = tools?.length && toolsEnabled(provider);
  const body = JSON.stringify({ model, messages, stream: true, ...(useTools ? { tools, tool_choice: 'auto' } : {}) });

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal?.aborted) throw signal.reason ?? new DOMException('Dibatalkan', 'AbortError');
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, IDLE_TIMEOUT_MS);
  };
  const timeoutError = () => Object.assign(new Error(`${provider.name} tidak merespons selama ${Math.round(IDLE_TIMEOUT_MS / 1000)} detik`), { status: 504 });

  try {
    let r;
    for (let attempt = 0; ; attempt++) {
      touch();
      try {
        r = await upstream(provider, '/chat/completions', { method: 'POST', body, signal: ctrl.signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (timedOut) throw timeoutError();
        if (attempt < MAX_RETRIES) {
          await wait(1500 * 2 ** attempt, signal);
          continue;
        }
        throw Object.assign(new Error(`Gagal konek ke ${provider.name}: ${err.cause?.code || err.message}`), { status: 502 });
      }
      if (r.ok || !RETRY_STATUS.has(r.status) || attempt >= MAX_RETRIES) break;
      const retryAfter = Math.min(Number(r.headers.get('retry-after')) * 1000 || 0, 15_000);
      await r.body?.cancel().catch(() => {});
      console.warn(`[llm] ${provider.name} HTTP ${r.status}, coba lagi (${attempt + 1}/${MAX_RETRIES})…`);
      await wait(retryAfter || 1500 * 2 ** attempt, signal);
    }

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      // Model/provider tanpa dukungan function calling: ulangi tanpa tools.
      if (useTools && r.status >= 400 && r.status < 500 && /tool|function/i.test(text)) {
        noToolsProviders.add(provider.id);
        console.warn(`[llm] ${provider.name} menolak tools, lanjut tanpa tools.`);
        return complete(provider, { model, messages: stripToolMessages(messages), tools: null, signal, onText });
      }
      throw Object.assign(new Error(`${provider.name} (${r.status}): ${text.slice(0, 400)}`), { status: r.status });
    }

    // Sebagian provider mengabaikan stream:true.
    if ((r.headers.get('content-type') || '').includes('application/json')) {
      const data = await r.json();
      const msg = data.choices?.[0]?.message || {};
      if (msg.content) onText?.(msg.content, msg.content);
      return {
        content: msg.content || '',
        toolCalls: (msg.tool_calls || []).map((t) => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments || '{}' })),
      };
    }

    let content = '';
    const calls = [];
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of r.body) {
        touch();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
          const delta = data.choices?.[0]?.delta || {};
          if (delta.content) {
            content += delta.content;
            onText?.(delta.content, content);
          }
          for (const tc of delta.tool_calls || []) {
            const i = tc.index ?? calls.length;
            calls[i] ||= { id: '', name: '', arguments: '' };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].name += tc.function.name;
            if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
          }
        }
      }
    } catch (err) {
      if (timedOut) throw timeoutError();
      throw err;
    }
    return {
      content,
      toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}`, arguments: c.arguments || '{}' })),
    };
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Untuk provider tanpa tools: ubah jejak tool call jadi teks biasa.
function stripToolMessages(messages) {
  return messages
    .map((m) => {
      if (m.role === 'tool') return { role: 'user', content: `[hasil tool] ${m.content}` };
      if (m.tool_calls) return { role: 'assistant', content: m.content || m.tool_calls.map((t) => `[memanggil ${t.function.name}]`).join(' ') };
      return m;
    })
    .filter((m) => m.content);
}

export function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .trim();
}
