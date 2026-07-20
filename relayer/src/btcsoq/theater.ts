/**
 * BTCSOQ theater — the operations terminal's engine room.
 *
 * The terminal (live.html) is ALIVE before anyone touches it, in the
 * soq402-console tradition: a scheduled demonstration runs itself on a
 * countdown, every viewer watches the same events over a shared broadcast
 * stream, and a settlement tape + session counters tick continuously.
 * Visitor-triggered programs ride the same rails and mirror into the tape.
 *
 * Surfaces (all under /api/btc/theater):
 *   GET /stream      shared broadcast SSE: tape events, heartbeat acts,
 *                    counter updates, next-demonstration clock
 *   GET /status      session stats, program budgets, agent cards, clocks
 *   GET /ask?q=      program 01 — pay-per-answer (per-visitor SSE)
 *   GET /duel?...    program 02 — M2M negotiation, Grok × Claude
 *   GET /race?laps=  program 03 — throughput vs the Bitcoin clock
 *
 * Gating is VISIBLE by design: every 429 carries retryAfterSec, /status
 * carries budget meters, and when the public budget is spent the scheduled
 * demonstration keeps the room alive. Nothing fails silently.
 *
 * Nothing is simulated and nothing persists — restart resets tape and
 * budgets (stricter, never looser). Costs are stagenet shors.
 */

import type express from 'express';
import { Ln402Client } from './ln402';
import { logger } from '../utils/logger';

export interface TheaterDeps {
  enabled: boolean;
  ln: () => Promise<Ln402Client>;
  grokUrl: string;
  claudeUrl: string;
  /** Race payee channel identity (a gateway signer key) */
  payee: () => Promise<{ address: string; pubkeyHex: string }>;
  /** Live Bitcoin context: vault truth + the measured confirmation wait */
  btcContext: () => Promise<Record<string, unknown>>;
  /** Recent gateway attestation events — Bitcoin's own lines on the tape */
  recentAttestations: (limit: number) => Array<{ id: string; kind: string; ts: number; payload: string }>;
  /** Miner beat (wr8): fire one real payout-shaped send across the boundary */
  minerBeat?: {
    sats: number;
    cap: number;
    send: () => Promise<{ txid: string; depositAddress: string; intentId: string; sats: number }>;
  };
}

/** Curated public questions (free-form is allowed but length-capped). */
const ASK_PRESETS: Record<string, string> = {
  shor: "In one sentence: what does Shor's algorithm do to the elliptic curve signatures that secure Bitcoin today?",
  harvest: 'In one sentence: what is a harvest-now-decrypt-later attack?',
  upgrade: "In one sentence: why can't Bitcoin simply swap its signature algorithm overnight?",
  lightning: 'In one sentence: what is a Lightning invoice?',
  paid: 'You were just paid one third of a cent over post-quantum Lightning to answer this. In one sentence: why does that matter for machines?',
};

const DUEL_PRESETS: Record<string, string> = {
  price: 'Negotiate with your counterpart: what is a fair price, in shors, for a one-sentence answer from an AI? Open with an offer.',
  speed: 'Explain to your counterpart, machine to machine, why your payments settle in milliseconds while a Bitcoin payment waits for blocks.',
  quantum: 'Your counterpart claims quantum computers will never threaten Bitcoin. Open the debate with your strongest two-sentence argument.',
};

/** Heartbeat rotation: what the terminal demonstrates on its own clock. */
const HEARTBEAT_ASKS = ['shor', 'paid', 'harvest', 'lightning', 'upgrade'];
const HEARTBEAT_EVERY_MS = 5 * 60_000;
const HEARTBEAT_RACE_EVERY = 4;   // every 4th heartbeat runs the race instead

const MAX_FREEFORM_CHARS = 140;
const DUEL_TURNS_DEFAULT = 4;
const DUEL_TURNS_MAX = 6;
const RACE_LAPS_DEFAULT = 10;
const RACE_LAPS_MAX = 12;
const RACE_LAP_SHORS = 1000;

const BUDGETS: Record<string, { cap: number; perMin: number }> = {
  ask: { cap: 500, perMin: 3 },
  duel: { cap: 60, perMin: 1 },
  race: { cap: 100, perMin: 1 },
};

// ── rate limiting (structured — the UI renders the countdown) ──
const hits = new Map<string, number[]>();
function retryAfterSec(ip: string, route: string): number {
  const key = `${route}:${ip}`;
  const now = Date.now();
  const perMin = BUDGETS[route].perMin;
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= perMin) {
    hits.set(key, recent);
    return Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
  }
  recent.push(now);
  hits.set(key, recent);
  return 0;
}

// ── daily budgets (public programs; the heartbeat runs off-budget) ──
const daily = new Map<string, { day: string; n: number }>();
function today(): string { return new Date().toISOString().slice(0, 10); }
function budgetUsed(route: string): number {
  const c = daily.get(route);
  return c && c.day === today() ? c.n : 0;
}
function takeBudget(route: string): boolean {
  const day = today();
  const c = daily.get(route);
  if (!c || c.day !== day) { daily.set(route, { day, n: 1 }); return true; }
  if (c.n >= BUDGETS[route].cap) return false;
  c.n += 1;
  return true;
}

// ── session stats + settlement tape (in-memory, resets on restart) ──
const session = {
  startedAt: Date.now(),
  acts: 0,
  messagesBilled: 0,
  shorsSettled: 0,
  receiptsVerified: 0,
  settleMsTotal: 0,
  settleMsCount: 0,
};
const agentEarned: Record<string, number> = { Grok: 0, Claude: 0 };

interface TapeEntry { ts: number; line: string; cls: string }
const tape: TapeEntry[] = [];

/**
 * The rarest event on the tape: a reward mined straight across the boundary,
 * confirmed inside our own block, its key never once shown while spendable.
 * The miner announces it here on a win. Held so late-joining boards (which
 * poll rather than stream) can still light up. Survives until the next win.
 */
interface QuantumDark {
  ts: number; txid: string; sats: number;
  blockHash: string; height: number; intentId: string;
}
let lastQuantumDark: QuantumDark | null = null;
function tapePush(line: string, cls = '') {
  tape.unshift({ ts: Date.now(), line, cls });
  if (tape.length > 80) tape.pop();
  broadcast({ kind: 'tape', ts: Date.now(), line, cls });
}

// ── broadcast channel (every open terminal shares this stream) ──
const viewers = new Set<express.Response>();
function broadcast(event: Record<string, unknown>) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of viewers) {
    try { res.write(frame); } catch { viewers.delete(res); }
  }
}
setInterval(() => {
  // Keepalive comment + watcher count (also defeats proxy idle timeouts)
  const frame = `: ping\ndata: ${JSON.stringify({ kind: 'watchers', n: viewers.size })}\n\n`;
  for (const res of viewers) {
    try { res.write(frame); } catch { viewers.delete(res); }
  }
}, 25_000);

function recordSettle(amountSat: number, payMs: number, agent?: string, receiptVerified?: boolean) {
  session.messagesBilled += 1;
  session.shorsSettled += amountSat;
  session.settleMsTotal += payMs;
  session.settleMsCount += 1;
  if (receiptVerified) session.receiptsVerified += 1;
  if (agent) agentEarned[agent] = (agentEarned[agent] ?? 0) + amountSat;
  broadcast({ kind: 'session', ...sessionView() });
}
function sessionView() {
  return {
    acts: session.acts,
    messagesBilled: session.messagesBilled,
    shorsSettled: session.shorsSettled,
    receiptsVerified: session.receiptsVerified,
    avgSettleMs: session.settleMsCount ? Math.round(session.settleMsTotal / session.settleMsCount) : null,
    earned: { ...agentEarned },
  };
}

/** Tape lines for one paid ask, wherever it came from. */
function tapeAsk(source: string, e: any) {
  if (e.stage === 'challenge') tapePush(`402 challenge · ${e.amountSat} shors · inv ${String(e.invoiceId).slice(0, 10)}`, 'c402');
  if (e.stage === 'paid') { tapePush(`paid ${e.amountSat} shors · settled in ${e.payMs}ms`, 'paid'); }
  if (e.stage === 'answer') {
    tapePush(`receipt signed ML-DSA-44 · ${e.receiptVerified ? 'verified' : 'UNVERIFIED'} · ${source}`, e.receiptVerified ? 'sealed' : 'warn');
  }
}

function isLocalhost(req: express.Request): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// ── SSE plumbing ──────────────────────────────────────────
function sseOpen(res: express.Response): (event: Record<string, unknown>) => void {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function resolveQuestion(raw: unknown, presets: Record<string, string>): string | null {
  const q = String(raw ?? '').trim();
  if (!q) return null;
  if (presets[q]) return presets[q];
  if (q.length > MAX_FREEFORM_CHARS) return null;
  return q;
}

/** Uniform gate: 429 with a countdown the UI can render. Never silent. */
function gate(req: express.Request, res: express.Response, route: string): boolean {
  const ip = req.socket.remoteAddress || 'unknown';
  const wait = retryAfterSec(ip, route);
  if (wait > 0) {
    res.status(429).json({ ok: false, reason: 'cooldown', retryAfterSec: wait,
      error: `This program is rate limited. Your next slot opens in ${wait}s.` });
    return false;
  }
  if (!takeBudget(route)) {
    res.status(429).json({ ok: false, reason: 'budget', retryAfterSec: secondsToUtcMidnight(),
      error: 'The public budget for this program is spent for today. It resets at 00:00 UTC. The scheduled demonstration keeps running.' });
    return false;
  }
  return true;
}
function secondsToUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

// ── the heartbeat: the terminal demonstrates itself ───────
let nextDemoAt = 0;
let heartbeatN = 0;
let heartbeatRunning = false;

async function runHeartbeat(deps: TheaterDeps) {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  heartbeatN += 1;
  const isRace = heartbeatN % HEARTBEAT_RACE_EVERY === 0;
  try {
    const ln = await deps.ln();
    session.acts += 1;
    if (isRace) {
      broadcast({ kind: 'demo', stage: 'start', program: 'race', laps: 5 });
      tapePush('scheduled demonstration · throughput, 5 payments', 'note');
      const payerChannel = await ln.ensureChannel();
      const p = await deps.payee();
      const payeeChannel = await ln.ensurePayeeChannel(p.address, p.pubkeyHex, 100_000_000);
      let view = await ln.channelView(payerChannel);
      const t0 = Date.now();
      for (let i = 1; i <= 5; i++) {
        const inv = await ln.createInvoice(payeeChannel, RACE_LAP_SHORS, `heartbeat lap ${i}`);
        const tLap = Date.now();
        try { await ln.payInvoiceFast(inv, payerChannel, view, RACE_LAP_SHORS); }
        catch { view = await ln.channelView(payerChannel); await ln.payInvoiceFast(inv, payerChannel, view, RACE_LAP_SHORS); }
        const ms = Date.now() - tLap;
        recordSettle(RACE_LAP_SHORS, ms);
        broadcast({ kind: 'demo', stage: 'lap', program: 'race', i, ms, amountSat: RACE_LAP_SHORS });
        tapePush(`paid ${RACE_LAP_SHORS} shors · settled in ${ms}ms · scheduled`, 'paid');
        await new Promise((r) => setTimeout(r, 400));
      }
      broadcast({ kind: 'demo', stage: 'done', program: 'race', totalMs: Date.now() - t0 });
    } else {
      const presetId = HEARTBEAT_ASKS[heartbeatN % HEARTBEAT_ASKS.length];
      const question = ASK_PRESETS[presetId];
      // Alternate the answering machine so the room meets both agents.
      const agent = heartbeatN % 2 === 0
        ? { name: 'Claude', url: deps.claudeUrl }
        : { name: 'Grok', url: deps.grokUrl };
      broadcast({ kind: 'demo', stage: 'start', program: 'ask', question, agent: agent.name });
      tapePush(`scheduled demonstration · ${agent.name} gets paid to think`, 'note');
      const r = await ln.performPaidAsk(question, agent.url, (e) => {
        broadcast({ kind: 'demo', program: 'ask', agent: agent.name, ...e });
        tapeAsk(`${agent.name} · scheduled`, e);
      });
      recordSettle(r.amountSat, r.payMs, agent.name, r.receiptVerified);
      broadcast({ kind: 'demo', stage: 'done', program: 'ask' });
    }
  } catch (err: any) {
    logger.warn(`[BTCSOQ:theater] heartbeat failed: ${err.message}`);
    tapePush('scheduled demonstration deferred (rail busy) · next on the clock', 'warn');
  } finally {
    heartbeatRunning = false;
    nextDemoAt = Date.now() + HEARTBEAT_EVERY_MS;
    broadcast({ kind: 'clock', nextDemoAt });
  }
}

// ── Bitcoin events join the tape (orange lines) ───────────
const tapedAttestations = new Set<string>();
function attLine(kind: string, payload: string): string | null {
  let p: any = {};
  try { p = JSON.parse(payload); } catch { /* keep empty */ }
  const sats = p.sats ? `${Number(p.sats).toLocaleString('en-US')} sats` : '';
  switch (kind) {
    case 'deposit-confirmed': return `bitcoin crossed the boundary · ${sats} confirmed in the vault`;
    case 'receipt-minted': return `receipt minted under ML-DSA-44 · ${sats} now quantum-safe`;
    case 'receipt-returned': return `receipt returned · ${sats} heading home`;
    case 'btc-released': return `bitcoin released · ${sats} back on the BTC chain`;
    case 'converted-usdsoq': return `crossed value converted to USDSOQ stablecoin`;
    case 'lightning-paid': return `crossed value paid an AI over post-quantum Lightning`;
    default: return null;
  }
}
function pollGatewayEvents(deps: TheaterDeps, seedOnly: boolean) {
  try {
    const recent = deps.recentAttestations(seedOnly ? 6 : 12);
    // Oldest first so the tape reads chronologically.
    for (const a of [...recent].reverse()) {
      if (tapedAttestations.has(a.id)) continue;
      tapedAttestations.add(a.id);
      const line = attLine(a.kind, a.payload);
      if (!line) continue;
      if (seedOnly) tape.unshift({ ts: a.ts, line, cls: 'btc' });   // history, no broadcast
      else tapePush(line, 'btc');
    }
    if (seedOnly) tape.sort((x, y) => y.ts - x.ts);
  } catch { /* next poll */ }
}

// ── agent health cache (for the cards) ────────────────────
const agentHealth: Record<string, { up: boolean; pub: string; checkedAt: number }> = {};
async function checkAgent(name: string, url: string) {
  try {
    const r = await (await fetch(`${url}/.well-known/soq402`, { signal: AbortSignal.timeout(5000) })).json() as any;
    agentHealth[name] = { up: !!r?.seller_pub, pub: String(r?.seller_pub ?? '').slice(0, 16), checkedAt: Date.now() };
  } catch {
    agentHealth[name] = { up: false, pub: agentHealth[name]?.pub ?? '', checkedAt: Date.now() };
  }
}

export function mountTheaterRoutes(app: express.Application, deps: TheaterDeps): void {
  // The miner beat is a gateway action, not an AI act — mount it whenever
  // it is configured, independent of the (heavier) AI theater stack.
  if (deps.minerBeat) {
    const beat = deps.minerBeat;
    BUDGETS.beat = { cap: beat.cap, perMin: 1 };
    app.post('/api/btc/theater/miner-beat', async (req, res) => {
      if (!gate(req, res, 'beat')) return;
      try {
        const r = await beat.send();
        tapePush(`miner beat · ${r.sats.toLocaleString('en-US')} sats en route to the boundary · tx ${r.txid.slice(0, 12)}…`, 'btc');
        tapePush(`the slow part now is Bitcoin itself: one confirmation, then the line fires on its own`, 'note');
        res.json({ ok: true, txid: r.txid, depositAddress: r.depositAddress, intentId: r.intentId, sats: r.sats });
      } catch (err: any) {
        logger.warn(`[BTCSOQ:theater] miner beat refused: ${err.message}`);
        res.status(503).json({ ok: false, error: 'The beat is resting (float protection or breaker). The scheduled demonstration keeps running.' });
      }
    });
    logger.info(`[BTCSOQ:theater] Miner beat armed: ${beat.sats} sats/press, ${beat.cap}/day public`);
  }

  // ── Quantum-dark crossing: the miner announces a win here ──
  // A reward mined straight across the boundary, confirmed inside our own
  // block, key never shown while spendable. Mounts independent of AI acts so
  // the booth boards celebrate even if the theater stack is off.
  app.post('/api/btc/theater/quantum-dark', (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ ok: false });
    const b = req.body || {};
    if (!b.txid || typeof b.txid !== 'string') {
      return res.status(400).json({ ok: false, error: 'txid required' });
    }
    const qd: QuantumDark = {
      ts: Date.now(),
      txid: String(b.txid),
      sats: Number(b.sats) || 0,
      blockHash: String(b.blockHash || ''),
      height: Number(b.height) || 0,
      intentId: String(b.intentId || ''),
    };
    lastQuantumDark = qd;
    tapePush('a quantum-dark coin was mined', 'qdark');
    tapePush(`reward crossed the boundary inside its own block · never broadcast · tx ${qd.txid.slice(0, 12)}…`, 'qdark');
    tapePush('its key was never shown while it could be spent · only a miner can make this coin', 'qdark');
    broadcast({ kind: 'quantum-dark', ...qd });
    logger.info(`[BTCSOQ:theater] quantum-dark crossing announced: ${qd.txid.slice(0, 16)}… (block ${qd.height})`);
    res.json({ ok: true });
  });
  app.get('/api/btc/theater/quantum-dark', (_req, res) => {
    res.json({ ok: true, quantumDark: lastQuantumDark });
  });

  if (!deps.enabled) {
    logger.info('[BTCSOQ:theater] AI acts disabled (theater config not set); miner beat mounts independently');
    return;
  }

  // Heartbeat clock: first demonstration ~20s after boot, then every 5 min.
  nextDemoAt = Date.now() + 20_000;
  setInterval(() => {
    if (Date.now() >= nextDemoAt && !heartbeatRunning) {
      runHeartbeat(deps).catch(() => { /* logged inside */ });
    }
  }, 1000);
  setInterval(() => { checkAgent('Grok', deps.grokUrl); checkAgent('Claude', deps.claudeUrl); }, 60_000);
  checkAgent('Grok', deps.grokUrl);
  checkAgent('Claude', deps.claudeUrl);
  // Bitcoin's own events on the tape: seed with recent history, then follow.
  pollGatewayEvents(deps, true);
  setInterval(() => pollGatewayEvents(deps, false), 20_000);

  // ── POST /api/btc/theater/miner-beat — one real payout, on demand ──
  if (deps.minerBeat) {
    const beat = deps.minerBeat;
    BUDGETS.beat = { cap: beat.cap, perMin: 1 };
    app.post('/api/btc/theater/miner-beat', async (req, res) => {
      if (!gate(req, res, 'beat')) return;
      try {
        const r = await beat.send();
        tapePush(`miner beat · ${r.sats.toLocaleString('en-US')} sats en route to the boundary · tx ${r.txid.slice(0, 12)}…`, 'btc');
        tapePush(`the slow part now is Bitcoin itself: one confirmation, then the line fires on its own`, 'note');
        res.json({ ok: true, txid: r.txid, depositAddress: r.depositAddress, intentId: r.intentId, sats: r.sats });
      } catch (err: any) {
        logger.warn(`[BTCSOQ:theater] miner beat refused: ${err.message}`);
        res.status(503).json({ ok: false, error: 'The beat is resting (float protection or breaker). The scheduled demonstration keeps running.' });
      }
    });
    logger.info(`[BTCSOQ:theater] Miner beat armed: ${beat.sats} sats/press, ${beat.cap}/day public`);
  }

  // ── GET /api/btc/theater/stream — the shared broadcast ──
  app.get('/api/btc/theater/stream', (req, res) => {
    const send = sseOpen(res);
    viewers.add(res);
    send({ kind: 'hello', nextDemoAt, watchers: viewers.size, session: sessionView(),
           tape: tape.slice(0, 30) });
    req.on('close', () => viewers.delete(res));
  });

  // ── GET /api/btc/theater/status — meters, cards, clocks ──
  app.get('/api/btc/theater/status', async (_req, res) => {
    let btc: Record<string, unknown> | null = null;
    try { btc = await deps.btcContext(); } catch { /* render without */ }
    res.json({
      ok: true,
      nextDemoAt,
      watchers: viewers.size,
      btc,
      session: sessionView(),
      budgets: Object.fromEntries(Object.entries(BUDGETS).map(([k, v]) =>
        [k, { used: budgetUsed(k), cap: v.cap }])),
      agents: [
        { name: 'Grok', ...agentHealth['Grok'], priceShors: 333, earnedSession: agentEarned.Grok },
        { name: 'Claude', ...agentHealth['Claude'], priceShors: 333, earnedSession: agentEarned.Claude },
      ],
      settlement: 'hosted L2SOQ channels (custodial, disclosed)',
      quantumDark: lastQuantumDark,
    });
  });

  // ── Program 01: pay-per-answer ────────────────────────
  app.get('/api/btc/theater/ask', async (req, res) => {
    if (!gate(req, res, 'ask')) return;
    const question = resolveQuestion(req.query.q, ASK_PRESETS);
    if (!question) return res.status(400).json({ ok: false, error: `q required (preset id or question ≤ ${MAX_FREEFORM_CHARS} chars)` });

    const send = sseOpen(res);
    send({ stage: 'start', question });
    try {
      const ln = await deps.ln();
      session.acts += 1;
      const r = await ln.performPaidAsk(question, deps.grokUrl, (e) => {
        send(e);
        tapeAsk('visitor', e);
      });
      recordSettle(r.amountSat, r.payMs, 'Grok', r.receiptVerified);
      send({ stage: 'done' });
    } catch (err: any) {
      logger.warn(`[BTCSOQ:theater] ask failed: ${err.message}`);
      send({ stage: 'error', message: 'The rail hiccuped. Try again.' });
      tapePush('visitor program failed · rail hiccup', 'warn');
    } finally {
      res.end();
    }
  });

  // ── Program 02: M2M negotiation (Grok × Claude) ───────
  app.get('/api/btc/theater/duel', async (req, res) => {
    if (!gate(req, res, 'duel')) return;
    const opener = resolveQuestion(req.query.opener ?? 'price', DUEL_PRESETS);
    if (!opener) return res.status(400).json({ ok: false, error: 'opener required (preset id or text)' });
    const turns = Math.min(Math.max(parseInt(String(req.query.turns)) || DUEL_TURNS_DEFAULT, 2), DUEL_TURNS_MAX);

    const send = sseOpen(res);
    send({ stage: 'start', opener, turns });
    tapePush(`M2M negotiation opened · ${turns} paid turns`, 'note');
    try {
      const ln = await deps.ln();
      session.acts += 1;
      const agents = [
        { name: 'Grok', url: deps.grokUrl },
        { name: 'Claude', url: deps.claudeUrl },
      ];
      const earned: Record<string, number> = { Grok: 0, Claude: 0 };
      let prompt = opener;
      let prevAnswer = '';
      for (let i = 0; i < turns; i++) {
        const agent = agents[i % 2];
        const other = agents[(i + 1) % 2];
        if (i > 0) {
          prompt = `You are ${agent.name}, an AI agent in a live machine-to-machine commerce demo. ` +
            `Another agent, ${other.name}, was just paid to say: "${prevAnswer.slice(0, 400)}". ` +
            `Reply to ${other.name} in at most two sentences. You are being paid per answer over post-quantum Lightning.`;
        }
        send({ stage: 'turn', i, agent: agent.name });
        const r = await ln.performPaidAsk(prompt, agent.url, (e) => send({ ...e, i, agent: agent.name }));
        earned[agent.name] += r.amountSat;
        recordSettle(r.amountSat, r.payMs, agent.name, r.receiptVerified);
        tapePush(`${agent.name} paid ${r.amountSat} shors · receipt ${r.receiptVerified ? 'verified' : 'UNVERIFIED'} · settled ${r.payMs}ms`, 'sealed');
        prevAnswer = r.answer;
        send({ stage: 'earnings', earned: { ...earned } });
      }
      send({ stage: 'done', earned });
      tapePush(`M2M negotiation closed · ${earned.Grok + earned.Claude} shors moved machine to machine`, 'note');
    } catch (err: any) {
      logger.warn(`[BTCSOQ:theater] duel failed: ${err.message}`);
      send({ stage: 'error', message: 'The rail hiccuped. Try again.' });
      tapePush('M2M negotiation failed · rail hiccup', 'warn');
    } finally {
      res.end();
    }
  });

  // ── Program 03: throughput vs the Bitcoin clock ───────
  app.get('/api/btc/theater/race', async (req, res) => {
    if (!gate(req, res, 'race')) return;
    const laps = Math.min(Math.max(parseInt(String(req.query.laps)) || RACE_LAPS_DEFAULT, 3), RACE_LAPS_MAX);

    const send = sseOpen(res);
    send({ stage: 'start', laps, lapShors: RACE_LAP_SHORS });
    try {
      const ln = await deps.ln();
      session.acts += 1;
      const payerChannel = await ln.ensureChannel();
      const p = await deps.payee();
      const payeeChannel = await ln.ensurePayeeChannel(p.address, p.pubkeyHex, 100_000_000);
      send({ stage: 'channels', payerChannel, payeeChannel });

      const t0 = Date.now();
      const lapMs: number[] = [];
      let view = await ln.channelView(payerChannel);
      for (let i = 1; i <= laps; i++) {
        const invoiceId = await ln.createInvoice(payeeChannel, RACE_LAP_SHORS, `race lap ${i}`);
        const tLap = Date.now();
        try {
          await ln.payInvoiceFast(invoiceId, payerChannel, view, RACE_LAP_SHORS);
        } catch {
          view = await ln.channelView(payerChannel);
          await ln.payInvoiceFast(invoiceId, payerChannel, view, RACE_LAP_SHORS);
        }
        const ms = Date.now() - tLap;
        lapMs.push(ms);
        recordSettle(RACE_LAP_SHORS, ms);
        send({ stage: 'lap', i, ms, amountSat: RACE_LAP_SHORS });
        if (i < laps) await new Promise((r) => setTimeout(r, 220));
      }
      const summary = {
        stage: 'done', laps,
        totalMs: Date.now() - t0,
        avgMs: Math.round(lapMs.reduce((a, b) => a + b, 0) / lapMs.length),
        totalShors: laps * RACE_LAP_SHORS,
      };
      send(summary);
      tapePush(`throughput · ${laps} payments · avg ${summary.avgMs}ms · visitor`, 'paid');
    } catch (err: any) {
      logger.warn(`[BTCSOQ:theater] race failed: ${err.message}`);
      send({ stage: 'error', message: 'The rail hiccuped. Try again.' });
      tapePush('throughput program failed · rail hiccup', 'warn');
    } finally {
      res.end();
    }
  });

  logger.info('[BTCSOQ:theater] Terminal engine mounted: /api/btc/theater/{stream,status,ask,duel,race} + heartbeat');
}
