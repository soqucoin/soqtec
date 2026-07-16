/**
 * BTCSOQ gateway persistence — JSON-file-backed store.
 *
 * The relayer has no database; demo scale is hundreds of intents, so a
 * single JSON state file with atomic writes (tmp + rename) is deliberate.
 * The receipt ledger itself stays rebuildable from chain data + OP_RETURN
 * tags (DL §4.4) — this file is operational state, not the source of truth.
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { BurnConfidence } from '../cea/types';

export type DepositIntentStatus =
  | 'awaiting-deposit'   // intent created, fresh P2TR issued
  | 'deposit-seen'       // in mempool (0 conf)
  | 'confirmed'          // met confirmation policy; SPV proof captured
  | 'minting'            // receipt mint in flight (Day 2)
  | 'minted'             // BTCSOQ receipt issued (Day 2)
  | 'expired'
  | 'failed';

export type RedeemIntentStatus =
  | 'awaiting-receipt'   // waiting for the receipt UTXO at the redemption addr (Day 2)
  | 'receipt-received'
  | 'released'           // BTC paid out (Day 2)
  | 'expired'
  | 'failed';

export interface BtcIntent {
  id: string;
  kind: 'deposit' | 'redeem';
  network: string;
  /** Attendee's ML-DSA-44 (Dilithium) Soqucoin address — receipt destination */
  ssqAddress: string;
  /** Deposit intents: fresh P2TR vault address bound to this intent */
  btcDepositAddress?: string;
  /** Redeem intents: BTC address the release pays out to */
  btcPayoutAddress?: string;
  status: DepositIntentStatus | RedeemIntentStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  // Deposit lifecycle fields
  depositTxid?: string;
  depositVout?: number;
  sats?: number;
  confirmations?: number;
  spvProof?: string;
  // Day 2
  mintTxid?: string;
  releaseTxid?: string;
}

export interface DepositRecord {
  /** `txid:vout` — the replay/idempotency key (DL §5) */
  key: string;
  txid: string;
  vout: number;
  address: string;
  sats: number;
  confirmations: number;
  confidence: BurnConfidence;
  /** null = unsolicited deposit (no intent bound to the address) */
  intentId: string | null;
  network: string;
  firstSeenAt: number;
  confirmedAt: number | null;
  blockHash?: string;
  blockHeight?: number;
  spvProof?: string;
}

interface GatewayState {
  intents: Record<string, BtcIntent>;
  deposits: Record<string, DepositRecord>;
  meta: { pollCursor?: string };
}

const EMPTY_STATE: GatewayState = { intents: {}, deposits: {}, meta: {} };

export class GatewayStore {
  private file: string;
  private state: GatewayState = { ...EMPTY_STATE, intents: {}, deposits: {}, meta: {} };
  private saveChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'btcsoq-state.json');
  }

  async load(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        intents: parsed.intents || {},
        deposits: parsed.deposits || {},
        meta: parsed.meta || {},
      };
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;   // corrupt state must fail loudly, not silently reset
    }
  }

  /** Atomic persist: write tmp, rename over. Serialized so saves never interleave. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.file);
    });
    return this.saveChain;
  }

  // ── Intents ────────────────────────────────────────────

  async putIntent(intent: BtcIntent): Promise<void> {
    this.state.intents[intent.id] = intent;
    await this.persist();
  }

  getIntent(id: string): BtcIntent | undefined {
    return this.state.intents[id];
  }

  findDepositIntentByAddress(btcAddress: string): BtcIntent | undefined {
    return Object.values(this.state.intents).find(
      (i) => i.kind === 'deposit' && i.btcDepositAddress === btcAddress
    );
  }

  listIntents(): BtcIntent[] {
    return Object.values(this.state.intents).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Deposits ───────────────────────────────────────────

  async putDeposit(dep: DepositRecord): Promise<void> {
    this.state.deposits[dep.key] = dep;
    await this.persist();
  }

  getDeposit(key: string): DepositRecord | undefined {
    return this.state.deposits[key];
  }

  listDeposits(): DepositRecord[] {
    return Object.values(this.state.deposits).sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  }

  // ── Meta ───────────────────────────────────────────────

  getPollCursor(): string | undefined {
    return this.state.meta.pollCursor;
  }

  async setPollCursor(cursor: string): Promise<void> {
    this.state.meta.pollCursor = cursor;
    await this.persist();
  }
}
