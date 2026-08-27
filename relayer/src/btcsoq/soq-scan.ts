/**
 * Stagenet chain scanner for the BTCSOQ gateway — read-only cold-node RPC
 * (same pattern as watchers/soqucoin.ts: getblock verbosity=2, no wallet).
 *
 * Two jobs, both grounded in chain truth rather than our own DB (DL §4.4):
 *   1. Mint recovery — after a crash or signer timeout, find whether a mint
 *      tx carrying a given BSQ1 tag actually broadcast (mempool + blocks
 *      since the claim height) BEFORE ever re-minting. This is the
 *      crash-safe half of the ledger CAS (the pool double-credit class).
 *   2. Redemption watching — scan new blocks for txs paying the redemption
 *      address, and match their INPUTS against recorded carrier outpoints
 *      (lineage: a redemption must spend the minted carrier).
 */

import { tagScriptHex, tagFromScriptHex, BtcsoqTag } from './receipt';
import { logger } from '../utils/logger';

export interface SoqScanConfig {
  rpcUrl: string;
  rpcUser: string;
  rpcPass: string;
}

export interface FoundMint {
  txid: string;
  height: number | null;   // null = mempool
  carrierAddress: string | null;
}

export interface RedemptionSpend {
  txid: string;
  height: number;
  /** Carrier outpoints (`mintTxid:vout`) this tx spends */
  spentCarriers: string[];
  /** BSQ redeem tag if the spender attached one (informational) */
  tag: BtcsoqTag | null;
  /** Shors paid to the redemption address (symbolic — release amount comes from the mint record) */
  paidShors: number;
}

export class SoqScanner {
  constructor(private config: SoqScanConfig) {}

  async tipHeight(): Promise<number> {
    return this.rpc('getblockcount');
  }

  /** Full node-side address validation (bech32m checksum + network HRP). */
  async validateAddress(address: string): Promise<boolean> {
    const res = await this.rpc('validateaddress', [address]);
    return res?.isvalid === true;
  }

  /**
   * Look for a broadcast mint tx carrying exactly this BSQ1 payload.
   * Checks the mempool first, then blocks [sinceHeight-2 .. tip].
   */
  async findMintTx(payload: Buffer, sinceHeight: number): Promise<FoundMint | null> {
    const wantScript = tagScriptHex(payload);

    // Mempool (stagenet mempool is small)
    const mempool: string[] = await this.rpc('getrawmempool');
    for (const txid of mempool) {
      try {
        const tx = await this.rpc('getrawtransaction', [txid, true]);
        if (this.txCarriesScript(tx, wantScript)) {
          return { txid, height: null, carrierAddress: this.voutAddress(tx.vout?.[0]) };
        }
      } catch { /* raced out of mempool — the block scan below covers it */ }
    }

    const tip = await this.tipHeight();
    const from = Math.max(0, sinceHeight - 2);   // small reorg margin
    if (tip - from > 5000) {
      logger.warn(`[BTCSOQ:scan] mint recovery scanning ${tip - from} blocks (claim height ${sinceHeight}) — long outage?`);
    }
    for (let h = from; h <= tip; h++) {
      const block = await this.block(h);
      for (const tx of block.tx || []) {
        if (this.txCarriesScript(tx, wantScript)) {
          return { txid: tx.txid, height: h, carrierAddress: this.voutAddress(tx.vout?.[0]) };
        }
      }
    }
    return null;
  }

  /**
   * Scan blocks (fromHeight, toHeight] for spends into the redemption address.
   * Coinbase txs can't spend carriers and are skipped via the vin check.
   */
  async scanRedemptions(
    redemptionAddress: string,
    fromHeight: number,
    toHeight: number,
    isCarrierOutpoint: (outpoint: string) => boolean,
  ): Promise<RedemptionSpend[]> {
    const found: RedemptionSpend[] = [];
    for (let h = fromHeight + 1; h <= toHeight; h++) {
      const block = await this.block(h);
      for (const tx of block.tx || []) {
        let paidShors = 0;
        let tag: BtcsoqTag | null = null;
        for (const vout of tx.vout || []) {
          if (this.voutAddress(vout) === redemptionAddress) {
            paidShors += Math.round((vout.value ?? 0) * 1e8);
          }
          tag = tag ?? tagFromScriptHex(vout.scriptPubKey?.hex || '');
        }
        if (paidShors <= 0) continue;

        const spentCarriers = (tx.vin || [])
          .filter((vin: any) => vin.txid !== undefined)
          .map((vin: any) => `${vin.txid}:${vin.vout}`)
          .filter(isCarrierOutpoint);

        found.push({ txid: tx.txid, height: h, spentCarriers, tag, paidShors });
      }
    }
    return found;
  }

  private txCarriesScript(tx: any, scriptHex: string): boolean {
    return (tx.vout || []).some((v: any) => v.scriptPubKey?.hex === scriptHex);
  }

  private voutAddress(vout: any): string | null {
    if (!vout) return null;
    const spk = vout.scriptPubKey || {};
    return spk.address ?? spk.addresses?.[0] ?? null;
  }

  private async block(height: number): Promise<any> {
    const hash = await this.rpc('getblockhash', [height]);
    return this.rpc('getblock', [hash, 2]);
  }

  private async rpc(method: string, params: any[] = []): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(
            `${this.config.rpcUser}:${this.config.rpcPass}`
          ).toString('base64'),
        },
        signal: ctrl.signal,
        body: JSON.stringify({ jsonrpc: '1.0', id: 'btcsoq-scan', method, params }),
      });
      const data = await resp.json() as any;
      if (data.error) {
        throw new Error(`stagenet RPC ${method} error: ${data.error.message}`);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }
}
