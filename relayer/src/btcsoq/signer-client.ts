/**
 * Client for the BTCSOQ gateway's dedicated soq-signer instance.
 *
 * The gateway runs its OWN signer instance (soq-privacy-signer pattern:
 * separate process, separate keystore, separate port) holding only the
 * gateway mint float — the production signer at 8550 is never touched and
 * receipts stay segregated from the pool payout wallet (cleaner PoR).
 *
 * The mint endpoint (/api/v1/send-btcsoq-mint) is purpose-bound the same
 * way send-sns is: it only accepts BSQ1-prefixed OP_RETURN payloads.
 */

import { logger } from '../utils/logger';

export interface MintSignerConfig {
  url: string;
  token: string;
  /** sat/vB. Stagenet floor is 1000 (soq-signer funding gotchas). */
  feeRate: number;
}

export interface SignerSendResult {
  txid: string;
  fee: number;
  inputs: number;
  outputs: number;
  elapsed: string;
}

export class MintSignerClient {
  constructor(private config: MintSignerConfig) {}

  /**
   * Atomic receipt mint: carrier UTXO to the recipient + BSQ1 OP_RETURN tag
   * in one tx (vout[0] = carrier, vout[1] = OP_RETURN, vout[2] = change).
   */
  async sendBtcsoqMint(params: {
    recipientAddress: string;
    amount: number;          // carrier value in shors
    opReturnHex: string;     // BSQ1-prefixed tag
    fromAddress: string;
  }): Promise<SignerSendResult> {
    return this.post('/api/v1/send-btcsoq-mint', {
      recipient_address: params.recipientAddress,
      amount: params.amount,
      op_return_hex: params.opReturnHex,
      from_address: params.fromAddress,
      fee_rate: this.config.feeRate,
    });
  }

  /** Signer-managed addresses (mint float / redemption / test-attendee keys). */
  async addresses(): Promise<string[]> {
    const res = await this.get('/api/v1/addresses');
    return res.addresses ?? [];
  }

  /** ML-DSA-44 signature (empty context, FIPS 204) over a 32-byte digest. */
  async signDigest(digestHex: string, address: string): Promise<string> {
    const res = await this.post('/api/v1/sign-digest', { digest_hex: digestHex, address });
    if (!res.signature_hex) throw new Error('signer returned no signature');
    return res.signature_hex;
  }

  /** The 1312-byte ML-DSA-44 public key for a signer address. */
  async pubkey(address: string): Promise<string> {
    const res = await this.get(`/api/v1/pubkey?address=${encodeURIComponent(address)}`);
    if (!res.pubkey_hex) throw new Error('signer returned no pubkey');
    return res.pubkey_hex;
  }

  async healthy(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(`${this.config.url}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: unknown): Promise<any> {
    // 180s: matches the signer's own WriteTimeout — ML-DSA-44 signing plus
    // UTXO refresh is slow, and the payoutMu serializes concurrent spends.
    return this.request('POST', path, body, 180_000);
  }

  private async get(path: string): Promise<any> {
    return this.request('GET', path, undefined, 15_000);
  }

  private async request(method: string, path: string, body: unknown, timeoutMs: number): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.config.url}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await resp.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`signer non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      if (!resp.ok) {
        throw new Error(`signer ${path} HTTP ${resp.status}: ${data.error || text.slice(0, 200)}`);
      }
      return data;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // A timeout is NOT "not broadcast" — the tx may have gone out.
        // Callers must chain-check before any retry (pool double-credit lesson).
        throw new Error(`signer ${path} timed out after ${timeoutMs}ms (tx may still have broadcast — chain-check before retry)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
