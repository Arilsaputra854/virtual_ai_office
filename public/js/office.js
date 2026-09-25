// "Sutradara" kantor: menempatkan agen, jalan-jalan saat idle, animasi koordinasi, dan rapat.
import { AgentAvatar } from './agent.js';
import { streamChat, runAgent } from './api.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class Office {
  constructor(world, config) {
    this.world = world;
    this.config = config;
    this.avatars = new Map();
    this.taken = new Set(); // spot yang sedang dipakai
    this.meeting = null;
    this.wander = true;

    const desks = world.useDesks(Math.min(config.agents.length, world.spots.desks.length));
    world.buildNavGrid();
    config.agents.forEach((data, i) => {
      const a = new AgentAvatar(world, data);
      a.home = desks[i] || { x: -9 + i * 0.6, z: 5.8, rotY: Math.PI, pose: 'stand' };
      a.home.screenMat?.color.set('#0f172a');
      a.place(a.home);
      a.setStatus('kerja');
      a.nextWander = performance.now() / 1000 + rand(15, 45);
      this.avatars.set(a.id, a);
    });

    world.animated.push((dt, t) => this.#tick(dt, t));
  }

  get(id) {
    return this.avatars.get(id);
  }

  // ---------- idle / jalan-jalan ----------

  #tick(dt, t) {
    const now = performance.now() / 1000;
    for (const a of this.avatars.values()) {
      a.update(dt, t);
      this.#updateScreen(a, t);
      if (this.wander && !a.busy.size && !a.visiting && !a.path.length && now > a.nextWander) {
        a.nextWander = now + rand(40, 110);
        if (a.spot === a.home) this.#wanderOut(a);
      }
    }
  }

  #updateScreen(a, t) {
    const mat = a.home.screenMat;
    if (!mat) return;
    const s = a.status;
    const atDesk = a.spot === a.home && !a.path.length;
    if (!atDesk) mat.color.set('#0f172a');
    else if (s === 'ngetik') mat.color.setHSL(0.58, 0.8, 0.45 + Math.sin(t * 18) * 0.06);
    else if (s === 'tool') mat.color.setHSL(0.4, 0.7, 0.4 + Math.sin(t * 8) * 0.06);
    else if (s === 'mikir') mat.color.setHSL(0.75, 0.6, 0.35 + Math.sin(t * 3) * 0.08);
    else if (s === 'error') mat.color.set('#7f1d1d');
    else mat.color.set('#1e40af');
  }

  #freeSpot(list) {
    const free = list.filter((s) => !this.taken.has(s));
    return free.length ? pick(free) : null;
  }

  async #wanderOut(a) {
    const toCoffee = Math.random() < 0.55;
    const spot = this.#freeSpot(toCoffee ? this.world.spots.coffee : this.world.spots.lounge);
    if (!spot) return;
    this.taken.add(spot);
    a.setStatus('jalan');
    const arrived = await a.goTo(spot);
    if (!arrived || a.spot !== spot) return this.taken.delete(spot);
    a.setStatus(toCoffee ? 'ngopi' : 'santai');
    await sleep(rand(12, 25) * 1000);
    this.taken.delete(spot);
    if (a.spot === spot && !a.busy.size) this.sendHome(a);
  }

  async sendHome(a, status = 'kerja') {
    if (a.spot !== a.home) {
      a.setStatus('jalan');
      const ok = await a.goTo(a.home);
      if (!ok) return;
    }
    if (a.serverStatus) a.setStatus(...a.serverStatus);
    else if (!a.busy.size) a.setStatus(status);
  }

  // ---------- chat 1-on-1 (dengan tools) ----------

  // Status & balon teks agen datang dari event server (applyEvent), bukan dari sini.
  async chat(agentId, messages, { onEvent, signal } = {}) {
    const a = this.get(agentId);
    if (!this.meeting?.ids.includes(agentId) && a.spot !== a.home && !a.visiting) this.sendHome(a);
    try {
      return await runAgent(agentId, messages, { signal, onEvent });
    } catch (err) {
      a.say(err.name === 'AbortError' ? 'Oke, berhenti.' : '⚠️ ' + err.message, 6000);
      throw err;
    }
  }

  // ---------- event live dari server ----------

  applyEvent(ev) {
    if (ev.type === 'board') {
      this.tasks = ev.tasks;
      this.world.setKanban(ev.tasks, (id) => this.get(id)?.data.color || '#94a3b8');
      return;
    }
    if (ev.type === 'handoff') return this.#visit(ev.from, ev.to, ev.text);
    const a = this.get(ev.agentId);
    if (!a) return;
    if (ev.type === 'say') {
      if (!a.busy.has('rapat')) a.say(ev.text, 6000);
      return;
    }
    if (ev.type !== 'agent') return;
    if (ev.status === 'idle') {
      a.busy.delete('server');
      a.serverStatus = null;
      setTimeout(() => {
        if (!a.busy.size && !a.path.length) a.setStatus(this.#restStatus(a));
      }, 300);
      return;
    }
    if (ev.status === 'error') {
      a.busy.delete('server');
      a.serverStatus = null;
      a.setStatus('error', ev.text ? 'error: ' + ev.text.slice(0, 40) : undefined);
      setTimeout(() => !a.busy.size && a.status === 'error' && a.setStatus(this.#restStatus(a)), 8000);
      return;
    }
    a.busy.add('server');
    a.serverStatus = [ev.status, ev.text || undefined];
    if (a.busy.has('rapat')) return;
    if (!a.path.length) a.setStatus(...a.serverStatus);
    // agen yang sedang mengerjakan kartu kembali ke mejanya
    if (ev.taskId && a.spot !== a.home && !a.path.length && !a.visiting) this.sendHome(a);
  }

  // Agen berjalan ke meja rekan untuk menyerahkan tugas / bertanya, lalu kembali.
  #visit(fromId, toId, text) {
    const a = this.get(fromId);
    const b = this.get(toId);
    if (!a || !b || a === b) return;
    a.say(`@${b.data.name}: ${text}`, 5000);
    if (a.busy.has('rapat') || b.busy.has('rapat')) return;
    (a.visits ||= []).push(b);
    if (a.visiting) return;
    a.visiting = true;
    (async () => {
      while (a.visits.length) {
        const target = a.visits.shift();
        const h = target.home;
        a.setStatus('jalan', `ke meja ${target.data.name}`);
        const ok = await a.goTo({ x: h.x + 0.4, z: h.z + 0.85, rotY: Math.PI, pose: 'stand' });
        if (!ok) break;
        a.root.rotation.y = Math.atan2(h.x - a.root.position.x, h.z - a.root.position.z);
        a.setStatus('ngobrol', `ngobrol sama ${target.data.name}`);
        target.say(`👍 siap, ${a.data.name}`, 2500);
        await sleep(1800);
      }
      a.visits = [];
      a.visiting = false;
      if (!a.busy.has('rapat')) await this.sendHome(a);
    })();
  }

  #restStatus(a) {
    if (a.spot === a.home) return 'kerja';
    if (this.world.spots.coffee.includes(a.spot)) return 'ngopi';
    return 'santai';
  }

  // ---------- rapat ----------

  // onEvent({type: 'turn'|'delta'|'done'|'summary'|'error'|'status', ...})
  async runMeeting({ topic, ids, rounds }, onEvent) {
    if (this.meeting) throw new Error('Masih ada rapat yang berjalan');
    const controller = new AbortController();
    const meeting = (this.meeting = { topic, ids, controller, transcript: [] });
    const people = ids.map((id) => this.get(id));
    const leader = people[0];
    const seats = [...this.world.spots.meeting];

    try {
      onEvent({ type: 'status', text: 'Peserta menuju ruang meeting…' });
      this.world.setTv('Rapat dimulai', [`Topik: ${topic}`, `Peserta: ${people.map((p) => p.data.name).join(', ')}`]);
      await Promise.all(
        people.map(async (p, i) => {
          p.busy.add('rapat');
          p.setStatus('jalan');
          const seat = seats[i % seats.length];
          await sleep(i * 250);
          await p.goTo(seat);
          p.setStatus('rapat');
        }),
      );

      const roster = people.map((p) => `- ${p.data.name}${p.data.role ? ` (${p.data.role})` : ''}`).join('\n');
      for (let r = 0; r < rounds; r++) {
        for (const p of people) {
          for (const other of people) other.say('');
          if (controller.signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
          onEvent({ type: 'turn', agent: p.data, round: r + 1 });
          const prompt = [
            `Kamu sedang rapat tim. Topik: "${topic}"`,
            `Peserta:\n${roster}`,
            meeting.transcript.length ? `Transkrip sejauh ini:\n${formatTranscript(meeting.transcript)}` : 'Kamu yang bicara pertama.',
            `Putaran ${r + 1} dari ${rounds}. Sekarang giliran kamu (${p.data.name}). Tanggapi dari sudut pandang peranmu: beri ide, sanggahan, atau langkah konkret. Maksimal 90 kata, jangan mengulang poin orang lain, jangan tulis namamu di awal.`,
          ].join('\n\n');
          const text = await this.#meetingTurn(p, prompt, controller.signal, (full) => onEvent({ type: 'delta', agent: p.data, text: full }));
          meeting.transcript.push({ name: p.data.name, text });
          onEvent({ type: 'done', agent: p.data, text });
        }
      }

      for (const other of people) other.say('');
      onEvent({ type: 'turn', agent: leader.data, round: 'kesimpulan' });
      const summaryPrompt = [
        `Kamu memimpin rapat dengan topik: "${topic}"`,
        `Transkrip:\n${formatTranscript(meeting.transcript)}`,
        'Tulis kesimpulan rapat dalam Bahasa Indonesia dengan format:\nKEPUTUSAN: <1 kalimat>\nTUGAS:\n- <Nama>: <tugas>\n(maks 5 tugas)\nRISIKO: <1 kalimat>',
      ].join('\n\n');
      const summary = await this.#meetingTurn(leader, summaryPrompt, controller.signal, (full) => onEvent({ type: 'delta', agent: leader.data, text: full }));
      meeting.summary = summary;
      onEvent({ type: 'summary', agent: leader.data, text: summary });
      this.world.setTv(`Hasil rapat: ${topic}`, stripThink(summary).split('\n').filter(Boolean));
      return meeting;
    } catch (err) {
      onEvent({ type: 'error', text: err.name === 'AbortError' ? 'Rapat dibatalkan.' : err.message });
      throw err;
    } finally {
      this.meeting = null;
      for (const p of people) {
        p.busy.delete('rapat');
        if (p !== leader) p.say('');
        p.nextWander = performance.now() / 1000 + rand(20, 60);
        await sleep(300);
        this.sendHome(p);
      }
    }
  }

  async #meetingTurn(p, prompt, signal, onText) {
    p.setStatus('mikir');
    try {
      const text = await streamChat(p.id, [{ role: 'user', content: prompt }], {
        signal,
        onDelta: (_d, full) => {
          p.setStatus('ngetik', 'lagi bicara…');
          p.say(stripThink(full), 0);
          onText(full);
        },
      });
      p.say(stripThink(text), 7000);
      return stripThink(text);
    } finally {
      p.setStatus('rapat');
    }
  }

  cancelMeeting() {
    this.meeting?.controller.abort();
  }
}

export function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .trim();
}

function formatTranscript(t) {
  return t.map((m) => `${m.name}: ${m.text}`).join('\n\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
