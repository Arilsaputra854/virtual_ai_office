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

// Satu langkah chat completion (streaming). Mengembalikan { content, toolCalls }.
export async function complete(provider, { model, messages, tools, signal, onText }) {
  const useTools = tools?.length && toolsEnabled(provider);
  const body = { model, messages, stream: true, ...(useTools ? { tools, tool_choice: 'auto' } : {}) };
  let r;
  try {
    r = await upstream(provider, '/chat/completions', { method: 'POST', body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw Object.assign(new Error(`Gagal konek ke ${provider.name}: ${err.cause?.code || err.message}`), { status: 502 });
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
  for await (const chunk of r.body) {
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
  return {
    content,
    toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}`, arguments: c.arguments || '{}' })),
  };
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
