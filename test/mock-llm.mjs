// Mock server OpenAI-compatible yang bisa melakukan tool call, untuk tes end-to-end.
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startMockLlm() {
  let flaky = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-1' }] }));
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (req.url.startsWith('/notools') && body.tools) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'tools is not supported by this model' } }));
    }
    const me = (body.messages[0]?.content.match(/Kamu adalah (\w+)/) || [])[1] || '?';
    const last = body.messages.at(-1);
    const u = last.role === 'user' ? last.content : '';
    if (/flaky/.test(u) && flaky++ === 0) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      return res.end('{"error":{"message":"rate limited"}}');
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.on('close', () => (res.closedByClient = true));
    const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    const text = async (t, delay = 2) => {
      for (const w of t.split(/(?<= )/)) {
        if (res.closedByClient) return;
        send({ content: w });
        await sleep(delay);
      }
      res.end('data: [DONE]\n\n');
    };
    const calls = (list) => {
      list.forEach(([name, args], index) => send({ tool_calls: [{ index, id: `c${index}${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }] }));
      res.end('data: [DONE]\n\n');
    };

    if (last.role === 'tool') return text(`(${me}) beres.`);
    if (/Subtugas yang kamu delegasikan/.test(u)) return text('LAPORAN AKHIR: API dan desain login siap, file api/login.md.');
    if (/Kamu mendapat tugas/.test(u) && /lambat/i.test(u)) return text('kerja '.repeat(400), 50);
    if (/Kamu mendapat tugas/.test(u) && me === 'Gilang') return calls([['write_file', { path: 'api/login.md', content: '# API login\n' }]]);
    if (/Kamu mendapat tugas/.test(u) && me === 'Dinda') return calls([['ask_agent', { agent: 'gilang', question: 'Field form login?' }]]);
    if (body.tools && /koordinasi/i.test(u)) {
      return calls([
        ['create_task', { assignee: 'gilang', title: 'Bikin API login', detail: 'Endpoint /login' }],
        ['create_task', { assignee: 'dinda', title: 'Desain halaman login', detail: 'Wireframe' }],
      ]);
    }
    return text(`Halo dari ${me}.`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
