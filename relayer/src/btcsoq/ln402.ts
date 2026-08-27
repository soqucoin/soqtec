/**
 * L2SOQ Lightning + SOQ-402 client — the finale hop of the BTCSOQ line
 * (WS3, DL-BTCSOQ-MIAMI §3): gateway value pays a post-quantum Lightning
 * invoice, and the invoice belongs to an AI that answers for money.
 *
 * Deliberately SDK-free: soq-lightning-sdk is ESM-only and this relayer
 * compiles to CommonJS, so the four hosted-rail REST calls are made
 * directly (they are small and their shapes are pinned by the Go structs
 * in soq-lightning-peer/internal/server). The hosted channel is custodial
 * LSP bookkeeping — disclosed on the page; the honest value link is the
 * attestation chain, not the rail.
 *
 * Channel identity: an address + ML-DSA-44 pubkey from the GATEWAY SIGNER
 * keystore (no in-process keys). On the hosted rail the eLTOO tx fields
 * are the literal string "placeholder" (payinvoice.go:182) — no signing
 * happens relayer-side.
 *
 * SOQ-402 flow (seller.ts contract):
 *   POST /v1/chat/completions (no payment)  → 402 + {invoice_id, seller_pub}
 *   pay the invoice on the LSP              → status "paid"
 *   SAME request + X-SOQ-Invoice header     → 200 + answer + ML-DSA-signed
 *                                              receipt (one payment = one
 *                                              inference; retry-safe until
 *                                              redeemed)
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';

/** @noble/post-quantum is ESM-only; Function() keeps tsc (CommonJS) from
 *  transpiling this into a require() that would throw ERR_REQUIRE_ESM. */
let noblePq: any = null;
async function mlDsa(): Promise<any> {
  if (!noblePq) {
    noblePq = await (Function('return import("@noble/post-quantum/ml-dsa.js")')() as Promise<any>);
  }
  return noblePq;
}

export interface Ln402Config {
  lspUrl: string;        // https://lsp.soqu.org
  sellerUrl: string;     // http://127.0.0.1:4020 (same VPS as the relayer)
  question: string;      // the on-stage question, fixed per demo
  dataDir: string;       // ln channel state persists at <dataDir>/ln-channel.json
  /** Gateway signer identity backing the channel (address + its pubkey) */
  channelAddress: string;
  channelPubkeyHex: string;
  channelCapacityShors: number;   // ≤ LSP max_channel_sat (100M shors)
}

interface LnChannelState {
  channelId: string;
  address: string;
  createdAt: number;
}

export interface Challenge402 {
  invoiceId: string;
  amountSat: number;
  sellerPub: string;
  expiresAt: string | null;
}

export interface Answer402 {
  answer: string;
  model: string;
  receipt: any;       // SignedReceipt {receipt, sig} — page re-verifies in-browser
  receiptVerified: boolean;
  responseSha256: string;
}

export class Ln402Client {
  private channel: LnChannelState | null = null;

  constructor(private config: Ln402Config) {}

  private get stateFile(): string {
    return join(this.config.dataDir, 'ln-channel.json');
  }

  private chatBody(question: string): string {
    // The EXACT same body is sent for challenge and redeem — the receipt's
    // request_sha256 then provably covers the question that was asked.
    return JSON.stringify({
      messages: [{ role: 'user', content: question }],
      max_tokens: 120,
    });
  }

  /** The gateway's hosted payer channel: load, validate, or open. */
  async ensureChannel(): Promise<string> {
    if (this.channel) return this.channel.channelId;

    try {
      const saved: LnChannelState = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      const ch = await this.lsp('GET', `/v1/channels/${saved.channelId}`);
      if (ch && ch.state === 'open') {
        this.channel = saved;
        return saved.channelId;
      }
      logger.warn(`[BTCSOQ:ln402] saved channel ${saved.channelId} is ${ch?.state ?? 'gone'} — reopening`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') logger.warn(`[BTCSOQ:ln402] channel state unreadable (${err.message}) — opening fresh`);
    }

    // Faucet-funded hosted open (the live-proven path): drip + open in one
    // call. Falls back to a plain open if the faucet declines.
    let channelId: string | null = null;
    try {
      const r = await this.lsp('POST', '/v1/faucet', {
        address: this.config.channelAddress,
        pub_key_hex: this.config.channelPubkeyHex,
        open_channel: true,
        amount_sat: this.config.channelCapacityShors,
        name: 'btcsoq-gateway',
      });
      if (r.success && r.channel_id) channelId = r.channel_id;
      else logger.warn(`[BTCSOQ:ln402] faucet open declined (${r.error ?? 'no channel_id'}) — trying plain open`);
    } catch (err: any) {
      logger.warn(`[BTCSOQ:ln402] faucet open failed (${err.message}) — trying plain open`);
    }
    if (!channelId) {
      const r = await this.lsp('POST', '/v1/channels', {
        initiator_pub_key_hex: this.config.channelPubkeyHex,
        capacity_sat: this.config.channelCapacityShors,
        initiator_name: 'btcsoq-gateway',
        csv_delay: 288,
        initiator_address: this.config.channelAddress,
      });
      if (!r.accepted || !r.channel_id) {
        throw new Error(`LSP channel open rejected: ${r.reject_reason ?? 'unknown'}`);
      }
      channelId = r.channel_id;
    }

    this.channel = { channelId: channelId!, address: this.config.channelAddress, createdAt: Date.now() };
    await fs.writeFile(this.stateFile, JSON.stringify(this.channel, null, 2), 'utf8');
    logger.info(`[BTCSOQ:ln402] hosted payer channel open: ${channelId} (capacity ${this.config.channelCapacityShors} shors)`);
    return channelId!;
  }

  /** Ask without paying → the 402 challenge (a fresh pending invoice).
   *  Defaults preserve the gateway leg's fixed question and seller. */
  async challenge(question?: string, sellerUrl?: string): Promise<Challenge402> {
    const resp = await this.seller(undefined, question ?? this.config.question, sellerUrl);
    if (resp.status !== 402) {
      throw new Error(`seller returned ${resp.status} to an unpaid request (expected 402)`);
    }
    const p = resp.body?.payment;
    if (!p?.invoice_id || !p?.seller_pub) {
      throw new Error('402 challenge missing invoice_id/seller_pub');
    }
    return {
      invoiceId: p.invoice_id,
      amountSat: Number(p.amount_sat),
      sellerPub: p.seller_pub,
      expiresAt: p.expires_at ?? null,
    };
  }

  /** Invoice status straight from the LSP: pending | paid | expired. */
  async invoiceStatus(invoiceId: string): Promise<string> {
    const inv = await this.lsp('GET', `/v1/invoices/${invoiceId}`);
    return inv.status;
  }

  /**
   * Pay a pending invoice from the gateway channel — one eLTOO state bump,
   * exactly the invoice amount initiator→peer (SDK payInvoice construction;
   * hosted rail accepts placeholder tx fields).
   */
  async payInvoice(invoiceId: string): Promise<void> {
    const channelId = await this.ensureChannel();
    const inv = await this.lsp('GET', `/v1/invoices/${invoiceId}`);
    if (inv.status !== 'pending') {
      if (inv.status === 'paid') return;   // crash between pay and record — done
      throw new Error(`invoice is ${inv.status}`);
    }
    const ch = await this.lsp('GET', `/v1/channels/${channelId}`);
    if (ch.state !== 'open') throw new Error(`channel not open (state=${ch.state})`);
    if (inv.amount_sat > ch.initiator_balance_sat) throw new Error('insufficient channel balance');

    const r = await this.lsp('POST', `/v1/invoices/${invoiceId}/pay`, {
      channel_id: channelId,
      state_index: ch.state_index + 1,
      initiator_balance_sat: ch.initiator_balance_sat - inv.amount_sat,
      peer_balance_sat: ch.peer_balance_sat + inv.amount_sat,
      update_tx_hex: 'placeholder',
      settlement_tx_hex: 'placeholder',
      ctv_hash: 'placeholder',
    });
    if (!r.accepted) throw new Error(`invoice pay rejected: ${r.reject_reason ?? 'unknown'}`);
  }

  /** Redeem a PAID invoice: same request + X-SOQ-Invoice → answer + receipt. */
  async redeem(invoiceId: string, expectedSellerPub: string, question?: string, sellerUrl?: string): Promise<Answer402> {
    const resp = await this.seller(invoiceId, question ?? this.config.question, sellerUrl);
    if (resp.status === 402) {
      throw new Error('seller re-challenged (invoice not paid or already redeemed)');
    }
    if (resp.status !== 200) {
      throw new Error(`seller redeem HTTP ${resp.status}: ${JSON.stringify(resp.body).slice(0, 200)}`);
    }
    const answer = resp.body?.choices?.[0]?.message?.content ?? '';
    const receipt = resp.body?.soq402?.receipt;
    if (!answer || !receipt?.receipt || !receipt?.sig) {
      throw new Error('paid response missing answer or signed receipt');
    }
    const receiptVerified = await this.verifyReceipt(receipt, expectedSellerPub);
    return {
      answer,
      model: resp.body?.model ?? receipt.receipt.model ?? 'unknown',
      receipt,
      receiptVerified,
      responseSha256: receipt.receipt.response_sha256 ?? createHash('sha256').update(answer, 'utf8').digest('hex'),
    };
  }

  // ── Theater primitives (the payoff acts ride the same rails) ──

  /**
   * One complete paid ask with staged progress events — the live theater
   * version of the gateway's 402 leg. Ephemeral: writes nothing anywhere,
   * every stage is the real rail (real invoice, real eLTOO state bump,
   * real signed receipt).
   */
  async performPaidAsk(
    question: string,
    sellerUrl: string,
    onEvent: (e: Record<string, unknown>) => void,
  ): Promise<Answer402 & { invoiceId: string; amountSat: number; payMs: number; totalMs: number }> {
    const t0 = Date.now();
    const c = await this.challenge(question, sellerUrl);
    onEvent({ stage: 'challenge', invoiceId: c.invoiceId, amountSat: c.amountSat, sellerPub: c.sellerPub });
    const tPay = Date.now();
    await this.payInvoice(c.invoiceId);
    const payMs = Date.now() - tPay;
    onEvent({ stage: 'paid', invoiceId: c.invoiceId, amountSat: c.amountSat, payMs });
    const ans = await this.redeem(c.invoiceId, c.sellerPub, question, sellerUrl);
    const totalMs = Date.now() - t0;
    onEvent({
      stage: 'answer', answer: ans.answer, model: ans.model,
      receiptVerified: ans.receiptVerified, receipt: ans.receipt, totalMs,
    });
    return { ...ans, invoiceId: c.invoiceId, amountSat: c.amountSat, payMs, totalMs };
  }

  /** A second hosted channel (the race payee), persisted separately. */
  private payeeChannel: LnChannelState | null = null;

  async ensurePayeeChannel(address: string, pubkeyHex: string, capacityShors: number): Promise<string> {
    if (this.payeeChannel) return this.payeeChannel.channelId;
    const file = join(this.config.dataDir, 'ln-race-payee.json');
    try {
      const saved: LnChannelState = JSON.parse(await fs.readFile(file, 'utf8'));
      const ch = await this.lsp('GET', `/v1/channels/${saved.channelId}`);
      if (ch && ch.state === 'open') {
        this.payeeChannel = saved;
        return saved.channelId;
      }
    } catch { /* open fresh below */ }
    const r = await this.lsp('POST', '/v1/channels', {
      initiator_pub_key_hex: pubkeyHex,
      capacity_sat: capacityShors,
      initiator_name: 'btcsoq-race-payee',
      csv_delay: 288,
      initiator_address: address,
    });
    if (!r.accepted || !r.channel_id) {
      throw new Error(`race payee channel open rejected: ${r.reject_reason ?? 'unknown'}`);
    }
    this.payeeChannel = { channelId: r.channel_id, address, createdAt: Date.now() };
    await fs.writeFile(file, JSON.stringify(this.payeeChannel, null, 2), 'utf8');
    logger.info(`[BTCSOQ:ln402] race payee channel open: ${r.channel_id}`);
    return r.channel_id;
  }

  /** Create a pending invoice on a channel (the race payee's side). */
  async createInvoice(channelId: string, amountSat: number, memo: string): Promise<string> {
    const r = await this.lsp('POST', '/v1/invoices', {
      channel_id: channelId, amount_sat: amountSat, memo, expiry_seconds: 300,
    });
    if (!r.invoice_id) throw new Error('LSP returned no invoice_id');
    return r.invoice_id;
  }

  /** Payer-channel view for the race's local state tracking. */
  async channelView(channelId: string): Promise<{ stateIndex: number; initiatorBal: number; peerBal: number }> {
    const ch = await this.lsp('GET', `/v1/channels/${channelId}`);
    if (ch.state !== 'open') throw new Error(`channel not open (state=${ch.state})`);
    return { stateIndex: ch.state_index, initiatorBal: ch.initiator_balance_sat, peerBal: ch.peer_balance_sat };
  }

  /**
   * Race-lane invoice pay: ONE request. The caller is the only writer on
   * the channel during a race, so it maintains the state view locally
   * instead of re-reading invoice + channel before every pay (which trips
   * the LSP front's per-IP rate limit at race speed). On a reject the
   * caller re-reads and retries once — the LSP stays the source of truth.
   */
  async payInvoiceFast(
    invoiceId: string,
    channelId: string,
    view: { stateIndex: number; initiatorBal: number; peerBal: number },
    amountSat: number,
  ): Promise<void> {
    const r = await this.lsp('POST', `/v1/invoices/${invoiceId}/pay`, {
      channel_id: channelId,
      state_index: view.stateIndex + 1,
      initiator_balance_sat: view.initiatorBal - amountSat,
      peer_balance_sat: view.peerBal + amountSat,
      update_tx_hex: 'placeholder',
      settlement_tx_hex: 'placeholder',
      ctv_hash: 'placeholder',
    });
    if (!r.accepted) throw new Error(`invoice pay rejected: ${r.reject_reason ?? 'unknown'}`);
    view.stateIndex += 1;
    view.initiatorBal -= amountSat;
    view.peerBal += amountSat;
  }

  /** Seller receipt check (canonicalization pinned to soq402/receipt.ts). */
  private async verifyReceipt(signed: { receipt: any; sig: string }, expectedSellerPub: string): Promise<boolean> {
    try {
      const r = signed.receipt;
      if (r.v !== 1 || r.seller_pub !== expectedSellerPub) return false;
      const canonical = JSON.stringify({
        v: r.v,
        invoice_id: r.invoice_id,
        amount_sat: r.amount_sat,
        model: r.model,
        request_sha256: r.request_sha256,
        response_sha256: r.response_sha256,
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        issued_at: r.issued_at,
        seller_pub: r.seller_pub,
      });
      const digest = createHash('sha256').update(canonical, 'utf8').digest();
      const { ml_dsa44 } = await mlDsa();
      return ml_dsa44.verify(
        Uint8Array.from(Buffer.from(signed.sig, 'hex')),
        Uint8Array.from(digest),
        Uint8Array.from(Buffer.from(r.seller_pub, 'hex')),
      );
    } catch {
      return false;
    }
  }

  private async seller(invoiceId: string | undefined, question: string, sellerUrl?: string): Promise<{ status: number; body: any }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);   // inference can be slow
    try {
      const resp = await fetch(`${sellerUrl ?? this.config.sellerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(invoiceId ? { 'X-SOQ-Invoice': invoiceId } : {}),
        },
        signal: ctrl.signal,
        body: this.chatBody(question),
      });
      const text = await resp.text();
      let body: any = {};
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
      return { status: resp.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  private async lsp(method: string, path: string, body?: unknown): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const resp = await fetch(`${this.config.lspUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await resp.text();
      let data: any;
      try { data = JSON.parse(text); } catch {
        throw new Error(`LSP non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      if (!resp.ok) {
        throw new Error(`LSP ${method} ${path} HTTP ${resp.status}: ${data.error || text.slice(0, 200)}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
