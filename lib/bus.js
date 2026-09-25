// Event bus sederhana + Server-Sent Events ke semua browser yang terbuka.
const clients = new Set();
const listeners = new Set();

export function emit(event) {
  const line = `data: ${JSON.stringify({ ...event, at: Date.now() })}\n\n`;
  for (const res of clients) res.write(line);
  for (const fn of listeners) fn(event);
}

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function attachClient(req, res, initialEvents = []) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  for (const ev of initialEvents) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

// Kirim teks streaming ke bus tapi dibatasi ~8x per detik.
export function throttledSay(agentId, extra = {}) {
  let last = 0;
  let timer = null;
  let pending = '';
  const flush = () => {
    timer = null;
    last = Date.now();
    emit({ type: 'say', agentId, text: pending, ...extra });
  };
  return (text) => {
    pending = text;
    if (timer) return;
    const wait = Math.max(0, 120 - (Date.now() - last));
    timer = setTimeout(flush, wait);
  };
}
