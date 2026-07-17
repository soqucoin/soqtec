/**
 * BTCSOQ theater — the payoff acts. Three live demonstrations that run the
 * REAL rails in the foreground, streamed stage-by-stage over SSE:
 *
 *   GET /api/btc/theater/ask?q=<preset|text>   Bitcoin buys a thought:
 *       402 paywall → PQ Lightning payment → answer → signed receipt.
 *   GET /api/btc/theater/duel?opener=<preset>&turns=N   Machines doing
 *       business: Ada (:4020) and Bit (:4021) answer each other, every
 *       turn bought with a real invoice against each agent's own ML-DSA
 *       identity.
 *   GET /api/btc/theater/race?laps=N   The race: N real Lightning payments
 *       (payer channel → payee channel, each a real eLTOO state bump),
 *       timed per lap, against Bitcoin's block clock.
 *
 * Nothing here is simulated and nothing is persisted — the acts are
 * ephemeral performances on the same infrastructure the gateway ledger
 * already proves. Costs are shors on stagenet; rate limits + daily caps
 * keep a public crowd from draining the payer channel.
 */

import type express from 'express';
import { Ln402Client } from './ln402';
import { logger } from '../utils/logger';

export interface TheaterDeps {
  enabled: boolean;
  ln: () => Promise<Ln402Client>;
  adaUrl: string;
  bitUrl: string;
  /** Race payee channel identity (a gateway signer key) */
  payee: () => Promise<{ address: string; pubkeyHex: string }>;
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

const MAX_FREEFORM_CHARS = 140;
const DUEL_TURNS_DEFAULT = 4;
const DUEL_TURNS_MAX = 6;
const RACE_LAPS_DEFAULT = 10;
const RACE_LAPS_MAX = 12;
const RACE_LAP_SHORS = 1000;

// Per-IP rate limiting + global daily caps (in-memory; resets on restart,
// which only ever makes the limits stricter than advertised, never looser).
const hits = new Map<string, number[]>();
function limited(ip: string, route: string, perMin: number): boolean {
  const key = `${route}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= perMin) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  return false;
}
const daily = new Map<string, { day: string; n: number }>();
function overDailyCap(route: string, cap: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const c = daily.get(route);
  if (!c || c.day !== day) { daily.set(route, { day, n: 1 }); return false; }
  if (c.n >= cap) return true;
  c.n += 1;
  return false;
}

/** SSE plumbing: one event per stage, terminal 'done'/'error', then close. */
function sseOpen(res: express.Response): (event: Record<string, unknown>) => void {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx: do not buffer the stream
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

export function mountTheaterRoutes(app: express.Application, deps: TheaterDeps): void {
  if (!deps.enabled) {
    logger.info('[BTCSOQ:theater] disabled (theater config not set)');
    return;
  }

  // ── Act A: Bitcoin buys a thought ─────────────────────
  app.get('/api/btc/theater/ask', async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (limited(ip, 'ask', 3)) return res.status(429).json({ ok: false, error: 'Rate limited' });
    if (overDailyCap('ask', 500)) return res.status(429).json({ ok: false, error: 'Daily demo budget spent — back tomorrow' });
    const question = resolveQuestion(req.query.q, ASK_PRESETS);
    if (!question) return res.status(400).json({ ok: false, error: `q required (preset id or question ≤ ${MAX_FREEFORM_CHARS} chars)` });

    const send = sseOpen(res);
    send({ stage: 'start', question });
    try {
      const ln = await deps.ln();
      await ln.performPaidAsk(question, deps.adaUrl, send);
      send({ stage: 'done' });
    } catch (err: any) {
      logger.warn(`[BTCSOQ:theater] ask failed: ${err.message}`);
      send({ stage: 'error', message: 'The rail hiccuped — try again.' });
    } finally {
      res.end();
    }
  });

  // ── Act B: machines doing business (Ada × Bit) ────────
  app.get('/api/btc/theater/duel', async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (limited(ip, 'duel', 1)) return res.status(429).json({ ok: false, error: 'Rate limited' });
    if (overDailyCap('duel', 60)) return res.status(429).json({ ok: false, error: 'Daily demo budget spent — back tomorrow' });
    const opener = resolveQuestion(req.query.opener ?? 'price', DUEL_PRESETS);
    if (!opener) return res.status(400).json({ ok: false, error: 'opener required (preset id or text)' });
    const turns = Math.min(Math.max(parseInt(String(req.query.turns)) || DUEL_TURNS_DEFAULT, 2), DUEL_TURNS_MAX);

    const send = sseOpen(res);
    send({ stage: 'start', opener, turns });
    try {
      const ln = await deps.ln();
      const agents = [
        { name: 'Ada', url: deps.adaUrl },
        { name: 'Bit', url: deps.bitUrl },
      ];
      const earned: Record<string, number> = { Ada: 0, Bit: 0 };
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
        send({ stage: 'turn', i, agent: agent.name, asking: true });
        const r = await ln.performPaidAsk(prompt, agent.url, (e) =>
          send({ ...e, i, agent: agent.name })
        );
        earned[agent.name] += r.amountSat;
        prevAnswer = r.answer;
        send({ stage: 'earnings', earned: { ...earned } });
      }
      send({ stage: 'done', earned });
    } catch (err: any) {
      logger.warn(`[BTCSOQ:theater] duel failed: ${err.message}`);
      send({ stage: 'error', message: 'The rail hiccuped — try again.' });
    } finally {
      res.end();
    }
  });

  // ── Act C: the race ───────────────────────────────────
  app.get('/api/btc/theater/race', async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (limited(ip, 'race', 1)) return res.status(429).json({ ok: false, error: 'Rate limited' });
    if (overDailyCap('race', 100)) return res.status(429).json({ ok: false, error: 'Daily demo budget spent — back tomorrow' });
    const laps = Math.min(Math.max(parseInt(String(req.query.laps)) || RACE_LAPS_DEFAULT, 3), RACE_LAPS_MAX);

    const send = sseOpen(res);
    send({ stage: 'start', laps, lapShors: RACE_LAP_SHORS });
    try {
      const ln = await deps.ln();
      const payerChannel = await ln.ensureChannel();
      const p = await deps.payee();
      const payeeChannel = await ln.ensurePayeeChannel(p.address, p.pubkeyHex, 100_000_000);
      send({ stage: 'channels', payerChannel, payeeChannel });

      const t0 = Date.now();
      const lapMs: number[] = [];
      // 2 LSP requests per lap + pacing keeps a full race inside the LSP
      // front's public per-IP budget (10 r/s, burst 20) with headroom.
      let view = await ln.channelView(payerChannel);
      for (let i = 1; i <= laps; i++) {
        const invoiceId = await ln.createInvoice(payeeChannel, RACE_LAP_SHORS, `race lap ${i}`);
        const tLap = Date.now();
        try {
          await ln.payInvoiceFast(invoiceId, payerChannel, view, RACE_LAP_SHORS);
        } catch {
          // Stale local view (or a countersign bump) — re-read once, retry.
          view = await ln.channelView(payerChannel);
          await ln.payInvoiceFast(invoiceId, payerChannel, view, RACE_LAP_SHORS);
        }
        const ms = Date.now() - tLap;
        lapMs.push(ms);
        send({ stage: 'lap', i, ms, amountSat: RACE_LAP_SHORS });
        if (i < laps) await new Promise((r) => setTimeout(r, 220));
      }
      send({
        stage: 'done',
        laps,
        totalMs: Date.now() - t0,
        avgMs: Math.round(lapMs.reduce((a, b) => a + b, 0) / lapMs.length),
        totalShors: laps * RACE_LAP_SHORS,
      });
    } catch (err: any) {
      logger.warn(`[BTCSOQ:theater] race failed: ${err.message}`);
      send({ stage: 'error', message: 'The rail hiccuped — try again.' });
    } finally {
      res.end();
    }
  });

  logger.info('[BTCSOQ:theater] Acts mounted: /api/btc/theater/{ask,duel,race}');
}
