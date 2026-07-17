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

/**
 * USDSOQ conversion ledger entry (WS2), keyed by the DEPOSIT outpoint —
 * one conversion per BTC loop, ever. Same CAS discipline as mints: the
 * claim write (status='converting') lands BEFORE any money moves, and the
 * treasury send is recovered from chain via its BSQ1 'C' tag, never re-sent
 * blind. The prod-signer convert call is idempotent per treasury outpoint
 * on the signer side, so phase two is retry-safe by construction.
 */
export type ConvertStatus =
  | 'converting'   // claimed; treasury send and/or convert call in flight
  | 'converted';   // USDSOQ paid out to the gateway's USDSOQ address

export interface ConvertRecord {
  /** BTC deposit `txid:vout` — the loop identity + idempotency key */
  key: string;
  intentId: string;
  ssqAddress: string;
  /** BTC sats of the loop this conversion extends */
  sats: number;
  /** SOQ shors sent into the convert treasury */
  soqInShors: number;
  /** Full BSQ1 'C' tag hex — treasury-send recovery scans match on this */
  opReturnHex: string;
  status: ConvertStatus;
  /** Stagenet tip height when the claim was written — bounds recovery scans */
  claimHeight: number;
  attempts: number;
  lastError?: string;
  /** The gateway's tagged SOQ deposit into the treasury */
  treasuryTxid?: string;
  /** The prod signer's USDSOQ payout tx */
  payoutTxid?: string;
  /** USDSOQ base units received (from the convert result) */
  usdsoqOutShors?: number;
  createdAt: number;
  updatedAt: number;
  convertedAt?: number;
}

/**
 * Lightning/SOQ-402 ledger entry (WS3), keyed by the DEPOSIT outpoint — one
 * paid AI answer per BTC loop, ever. The 402 rail is naturally two-phase
 * crash-safe: the challenge pins an invoice id; paying is idempotent-checked
 * against LSP invoice status; redeeming retries safely until the seller
 * marks the invoice redeemed. Worst crash case strands one paid-but-never-
 * redeemed invoice (333 shors) — logged, never doubled silently.
 */
export type Ln402Status =
  | 'asking'     // claimed; challenge/pay/redeem in flight
  | 'answered';  // paid answer + signed seller receipt captured

export interface Ln402Record {
  /** BTC deposit `txid:vout` — the loop identity + idempotency key */
  key: string;
  intentId: string;
  ssqAddress: string;
  /** BTC sats of the loop this answer extends */
  sats: number;
  status: Ln402Status;
  question: string;
  invoiceId?: string;
  amountSat?: number;
  sellerPub?: string;
  answer?: string;
  model?: string;
  /** The seller's ML-DSA-44 SignedReceipt {receipt, sig} — page re-verifies it */
  receipt?: unknown;
  receiptVerified?: boolean;
  responseSha256?: string;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  answeredAt?: number;
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

/**
 * A Bitcoin anchor (WS4): the merkle root of the attestation ledger,
 * written into a testnet4 OP_RETURN. The fortress's books, notarized by
 * the parent chain itself.
 */
export interface AnchorRecord {
  ts: number;
  /** Merkle root hex over attestation digests (recipe in the API response) */
  root: string;
  leafCount: number;
  /** The Bitcoin transaction carrying the OP_RETURN */
  txid: string;
}

interface GatewayState {
  intents: Record<string, BtcIntent>;
  deposits: Record<string, DepositRecord>;
  mints: Record<string, MintRecord>;
  converts: Record<string, ConvertRecord>;
  ln402: Record<string, Ln402Record>;
  attestations: Record<string, AttestationRecord>;
  anchors: AnchorRecord[];
  meta: { pollCursor?: string; soqScanHeight?: number };
}

const EMPTY_STATE: GatewayState = { intents: {}, deposits: {}, mints: {}, converts: {}, ln402: {}, attestations: {}, anchors: [], meta: {} };

export class GatewayStore {
  private file: string;
  private state: GatewayState = { ...EMPTY_STATE, intents: {}, deposits: {}, mints: {}, converts: {}, ln402: {}, attestations: {}, anchors: [], meta: {} };
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
        converts: parsed.converts || {},
        ln402: parsed.ln402 || {},
        attestations: parsed.attestations || {},
        anchors: parsed.anchors || [],
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

  // ── Conversion ledger (WS2) ────────────────────────────

  /**
   * Claim a deposit outpoint for USDSOQ conversion. Returns false if ANY
   * record already exists for the key — same contract as claimMint: after
   * a false, the caller must never move money for this key.
   */
  async claimConvert(rec: ConvertRecord): Promise<boolean> {
    if (this.state.converts[rec.key]) return false;
    this.state.converts[rec.key] = rec;
    await this.persist();
    return true;
  }

  async putConvert(rec: ConvertRecord): Promise<void> {
    rec.updatedAt = Date.now();
    this.state.converts[rec.key] = rec;
    await this.persist();
  }

  getConvert(key: string): ConvertRecord | undefined {
    return this.state.converts[key];
  }

  listConverts(): ConvertRecord[] {
    return Object.values(this.state.converts).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Lightning/402 ledger (WS3) ─────────────────────────

  /** Claim a deposit outpoint for the 402 leg. Same CAS contract as mints. */
  async claimLn402(rec: Ln402Record): Promise<boolean> {
    if (this.state.ln402[rec.key]) return false;
    this.state.ln402[rec.key] = rec;
    await this.persist();
    return true;
  }

  async putLn402(rec: Ln402Record): Promise<void> {
    rec.updatedAt = Date.now();
    this.state.ln402[rec.key] = rec;
    await this.persist();
  }

  getLn402(key: string): Ln402Record | undefined {
    return this.state.ln402[key];
  }

  listLn402(): Ln402Record[] {
    return Object.values(this.state.ln402).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Bitcoin anchors (WS4) ──────────────────────────────

  async putAnchor(rec: AnchorRecord): Promise<void> {
    this.state.anchors.unshift(rec);
    if (this.state.anchors.length > 50) this.state.anchors.pop();
    await this.persist();
  }

  lastAnchor(): AnchorRecord | undefined {
    return this.state.anchors[0];
  }

  listAnchors(): AnchorRecord[] {
    return this.state.anchors;
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
