/**
 * BTCSOQ attestation records — every gateway money event is signed with a
 * REAL ML-DSA-44 (FIPS 204) key held by the gateway signer, and the feed is
 * independently verifiable in any browser via @noble/post-quantum.
 *
 * Honesty rules (the Solana-lane findings, beads elo/o5h/ccz, do not repeat
 * here): signatures are produced by the signer's keymanager over a real
 * digest, never zeroed placeholders, and verification needs nothing from us
 * beyond this feed + the published pubkey.
 *
 * Verification contract (documented in the feed response): the signature is
 * ML-DSA-44 with EMPTY context over the 32-byte SHA-256 digest of the EXACT
 * `payload` string stored in the record. Verifiers recompute
 * sha256(payload) and call ml_dsa44.verify(pubkey, digest, signature).
 * Storing the signed string verbatim removes canonicalization ambiguity.
 */

import { createHash } from 'crypto';

export type AttestedEventKind =
  | 'deposit-confirmed'   // BTC in the vault at policy confirmations
  | 'receipt-minted'      // BTCSOQ receipt issued on stagenet
  | 'receipt-returned'    // receipt carrier spent to the redemption address
  | 'btc-released';       // BTC paid back out

export interface AttestationRecord {
  /** `${kind}:${depositKey}` — one attestation per event per deposit, ever */
  id: string;
  kind: AttestedEventKind;
  /** The EXACT string that was signed */
  payload: string;
  /** sha256(payload) — what the signature actually covers */
  digestHex: string;
  /** ML-DSA-44 signature hex (2420 bytes); null until signed (retried) */
  signatureHex: string | null;
  signerAddress: string;
  ts: number;
}

export interface AttestationFields {
  kind: AttestedEventKind;
  network: string;
  /** Deposit outpoint `txid:vout` — the loop's identity */
  key: string;
  intentId: string;
  ssqAddress: string;
  sats: number;
  /** The transaction this event points at (deposit/mint/spend/release txid) */
  txid: string;
  ts: number;
}

/** Fixed field order, no whitespace — but verifiers never re-serialize:
 *  they hash the stored `payload` string as-is. */
export function buildPayload(f: AttestationFields): string {
  return JSON.stringify({
    v: 1,
    asset: 'BTCSOQ',
    kind: f.kind,
    network: f.network,
    key: f.key,
    intentId: f.intentId,
    ssqAddress: f.ssqAddress,
    sats: f.sats,
    txid: f.txid,
    ts: f.ts,
  });
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
