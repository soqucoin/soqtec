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
import type { AttestationRecord } from './attestation';

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
  // Money loop (Day 2)
  mintTxid?: string;
  receiptSpendTxid?: string;
  releaseTxid?: string;
  failReason?: string;
}

/**
 * Receipt mint ledger entry, keyed by the DEPOSIT outpoint (`txid:vout`).
 * The claim write (status='minting') happens BEFORE the signer call — the
 * CAS half of crash-safe minting. A record stuck in 'minting' is only ever
 * resolved by a chain scan (found → finalize; not found → retry), never by
 * blind re-mint (the pool double-credit class, deliberately not replicated).
 */
export type MintStatus =
  | 'minting'      // claimed; signer call in flight or awaiting recovery/retry
  | 'minted'       // receipt tx on chain (carrier = mintTxid:0)
  | 'redeeming'    // receipt returned; BTC release claimed, in flight
  | 'redeemed';    // BTC released

export interface MintRecord {
  /** Deposit `txid:vout` — the replay/idempotency key */
  key: string;
  intentId: string;
  ssqAddress: string;
  /** BTC sats this receipt is backed by (== released on redemption) */
  sats: number;
  carrierShors: number;
  /** Full BSQ1 tag hex — recovery scans match on this */
  opReturnHex: string;
  status: MintStatus;
  /** Stagenet tip height when the claim was written — bounds recovery scans */
  claimHeight: number;
  attempts: number;
  lastError?: string;
  mintTxid?: string;
  /** When the mint tx actually broadcast (daily-cap accounting) */
  mintedAt?: number;
  /** When the BTC release actually broadcast (daily-cap accounting) */
  releasedAt?: number;
  /** Redemption linkage */
  redeemIntentId?: string;
  receiptSpendTxid?: string;
  releaseTxid?: string;
  createdAt: number;
  updatedAt: number;
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
  mints: Record<string, MintRecord>;
  attestations: Record<string, AttestationRecord>;
  meta: { pollCursor?: string; soqScanHeight?: number };
}

const EMPTY_STATE: GatewayState = { intents: {}, deposits: {}, mints: {}, attestations: {}, meta: {} };

export class GatewayStore {
  private file: string;
  private state: GatewayState = { ...EMPTY_STATE, intents: {}, deposits: {}, mints: {}, attestations: {}, meta: {} };
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
        mints: parsed.mints || {},
        attestations: parsed.attestations || {},
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

  // ── Mint ledger ────────────────────────────────────────

  /**
   * Claim a deposit outpoint for minting. Returns false if ANY record
   * already exists for the key (whatever its status) — the caller must
   * never proceed to the signer after a false. This is the CAS that runs
   * BEFORE the signer call (DL §5 replay design).
   */
  async claimMint(rec: MintRecord): Promise<boolean> {
    if (this.state.mints[rec.key]) return false;
    this.state.mints[rec.key] = rec;
    await this.persist();
    return true;
  }

  async putMint(rec: MintRecord): Promise<void> {
    rec.updatedAt = Date.now();
    this.state.mints[rec.key] = rec;
    await this.persist();
  }

  getMint(key: string): MintRecord | undefined {
    return this.state.mints[key];
  }

  listMints(): MintRecord[] {
    return Object.values(this.state.mints).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Look up a mint by its carrier outpoint (`mintTxid:0`). */
  findMintByCarrier(outpoint: string): MintRecord | undefined {
    const [txid, voutStr] = outpoint.split(':');
    if (voutStr !== '0') return undefined;   // carrier is always vout[0] by construction
    return Object.values(this.state.mints).find((m) => m.mintTxid === txid);
  }

  // ── Attestations ───────────────────────────────────────

  async putAttestation(rec: AttestationRecord): Promise<void> {
    this.state.attestations[rec.id] = rec;
    await this.persist();
  }

  getAttestation(id: string): AttestationRecord | undefined {
    return this.state.attestations[id];
  }

  listAttestations(): AttestationRecord[] {
    return Object.values(this.state.attestations).sort((a, b) => b.ts - a.ts);
  }

  // ── Meta ───────────────────────────────────────────────

  getPollCursor(): string | undefined {
    return this.state.meta.pollCursor;
  }

  async setPollCursor(cursor: string): Promise<void> {
    this.state.meta.pollCursor = cursor;
    await this.persist();
  }

  /** Stagenet redemption-scan cursor (block height). */
  getSoqScanHeight(): number | undefined {
    return this.state.meta.soqScanHeight;
  }

  async setSoqScanHeight(height: number): Promise<void> {
    this.state.meta.soqScanHeight = height;
    await this.persist();
  }
}
