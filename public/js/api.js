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
