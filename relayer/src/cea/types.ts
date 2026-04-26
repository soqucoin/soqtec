/**
 * Chain Event Adapter (CEA) — Type Definitions
 *
 * The CEA abstraction makes the SOQ-TEC relayer chain-agnostic.
 * Each source chain implements the ChainEventAdapter interface,
 * providing both push-based (webhook) and pull-based (polling)
 * burn detection. The relayer core doesn't know or care which
 * chain the burn came from.
 *
 * Patent reference: SOQ-P006 Section 3 — Multi-Provider Resilience
 */

/** Confidence levels for burn detection */
export type BurnConfidence =
  | 'mempool'      // Seen in mempool but not confirmed (DUA speculative)
  | 'confirmed'    // Included in a block but not finalized
  | 'finalized';   // Irreversible — safe for optimistic release

/** Normalized burn event from ANY source chain */
export interface NormalizedBurnEvent {
  /** Source chain identifier */
  chain: ChainId;

  /** Unique burn transaction ID (chain-specific format) */
  burnTxId: string;

  /** Gross burn amount in the SOURCE chain's smallest unit */
  grossAmount: bigint;

  /** Net amount after bridge fee, in SOQ's smallest unit (satoshis) */
  netAmountSoq: bigint;

  /** Bridge fee retained on source chain */
  feeAmount: bigint;

  /** Destination Soqucoin address (bech32m sq1p...) */
  recipientSoq: string;

  /** Monotonic nonce from bridge contract (replay protection) */
  nonce: number;

  /** Current confidence level */
  confidence: BurnConfidence;

  /** When the burn was first detected (unix ms) */
  detectedAt: number;

  /** When the burn reached 'finalized' confidence (unix ms, null if not yet) */
  finalizedAt: number | null;

  /** Raw chain-specific metadata (for logging/debugging) */
  rawMeta?: Record<string, unknown>;
}

/** Supported source chains */
export type ChainId =
  | 'solana'
  | 'ethereum'
  | 'bitcoin'
  | 'litecoin'
  | 'cosmos';

/** Result of on-chain burn verification */
export interface VerifyResult {
  valid: boolean;
  confidence: BurnConfidence;
  error?: string;
  /** Block height where the burn was included */
  blockHeight?: number;
  /** Number of confirmations */
  confirmations?: number;
}

/** Callback type for push-based burn notifications */
export type BurnCallback = (event: NormalizedBurnEvent) => void | Promise<void>;

/**
 * Chain Event Adapter Interface
 *
 * Each source chain implements this interface to provide burn detection.
 * The relayer registers a callback via subscribeBurns() for push-based
 * notifications, and can also use pollBurns() as a fallback.
 *
 * Patent claim: "Multi-Provider Resilience — the architecture supports
 * N webhook providers operating concurrently" (P006 §3.2)
 */
export interface ChainEventAdapter {
  /** Human-readable chain name */
  readonly chainId: ChainId;

  /**
   * Push-based: register a callback that fires on every detected burn.
   * May use webhooks, websockets, ZMQ, or any push mechanism.
   * Should gracefully handle provider outages and reconnect.
   */
  subscribeBurns(callback: BurnCallback): Promise<void>;

  /**
   * Pull-based: poll for burns since a reference point.
   * Used as a fallback if push notifications are delayed or unavailable.
   * Returns burns in chronological order (oldest first).
   *
   * @param sinceRef - Chain-specific reference (block hash, signature, etc.)
   *                   Pass null to start from "now" (skip history).
   * @returns Array of burns and the new reference point for the next poll.
   */
  pollBurns(sinceRef: string | null): Promise<{
    burns: NormalizedBurnEvent[];
    nextRef: string;
  }>;

  /**
   * On-chain verification of a specific burn.
   * Called BEFORE releasing SOQ to confirm the burn is real and finalized.
   *
   * Patent claim: "independently verifying the burn transaction on the
   * first blockchain by confirming the transaction signature corresponds
   * to a finalized, irreversible state change" (P006 Claim 1(d))
   */
  verifyBurn(burnTxId: string): Promise<VerifyResult>;

  /** Start the adapter (connect to providers, initialize state) */
  start(): Promise<void>;

  /** Stop the adapter (disconnect, clean up) */
  stop(): Promise<void>;

  /** Health check — is the adapter currently connected and operational? */
  isHealthy(): boolean;
}
