/**
 * Bitcoin Chain Event Adapter (CEA)
 *
 * Fills the extension point designed into the CEA layer (see index.ts:
 * "Future: router.registerAdapter(new BitcoinCEA(btcConfig))").
 *
 * Semantics note: on the Bitcoin lane, the "burn" the CEA interface speaks
 * of is a DEPOSIT — BTC locked into the gateway vault. The event ID is
 * `txid:vout` so replay/idempotency is per-output (DL §5, replay design).
 *
 * Detection channels:
 *   Pull — `listsinceblock` on the watch-only deposits wallet (the classic
 *          exchange deposit pattern; cursor maps 1:1 onto pollBurns/sinceRef).
 *   Push — bitcoind `blocknotify` hits POST /api/btc/block-notify, which
 *          calls checkNow(). No ZMQ native dependency needed for the demo;
 *          ZMQ endpoints are configured on the node if we want them later.
 *
 * SPV proofs via `gettxoutproof` (node runs txindex=1), self-checked with
 * `verifytxoutproof` — rendered on the Terminal so attendees can re-verify
 * against public explorers. DL-BTC-SOQTEC-GATEWAY-2026-07-16.md §4.1, §5.
 */

import {
  ChainEventAdapter,
  NormalizedBurnEvent,
  BurnCallback,
  VerifyResult,
  BurnConfidence,
} from './types';
import { BitcoinRpc, btcToSats } from '../btcsoq/rpc';
import { logger } from '../utils/logger';

export interface BitcoinCEAConfig {
  network: 'testnet4' | 'regtest' | 'signet' | 'mainnet';
  rpcUrl: string;
  rpcUser: string;
  rpcPass: string;
  /** Watch-only descriptor wallet holding deposit addresses */
  depositWallet: string;
  /**
   * Confirmations at which a deposit is treated as final.
   * Demo policy on testnet4/regtest = 1 (disclosed on-screen);
   * mainnet policy = 6 (stated). DL §4.5 — honest confirmation policy.
   */
  finalityConf: number;
  pollIntervalMs: number;
}

export class BitcoinCEA implements ChainEventAdapter {
  readonly chainId = 'bitcoin' as const;

  private config: BitcoinCEAConfig;
  private node: BitcoinRpc;
  private wallet: BitcoinRpc;
  private callback: BurnCallback | null = null;
  private cursor: string | null = null;   // listsinceblock lastblock cursor
  private healthy: boolean = false;
  private checking: boolean = false;      // re-entrancy guard for checkNow()

  constructor(config: BitcoinCEAConfig) {
    this.config = config;
    this.node = new BitcoinRpc({
      url: config.rpcUrl,
      user: config.rpcUser,
      pass: config.rpcPass,
    });
    this.wallet = this.node.forWallet(config.depositWallet);
  }

  async start(savedCursor?: string | null): Promise<void> {
    logger.info(`[CEA:Bitcoin] Starting (${this.config.network}, wallet=${this.config.depositWallet}, finality=${this.config.finalityConf} conf)`);

    const info = await this.node.call('getblockchaininfo');
    logger.info(`[CEA:Bitcoin] Connected — chain=${info.chain} height=${info.blocks} progress=${(info.verificationprogress * 100).toFixed(2)}%`);

    // Make sure the deposits wallet is actually loaded on this node
    const wallets: string[] = await this.node.call('listwallets');
    if (!wallets.includes(this.config.depositWallet)) {
      await this.node.call('loadwallet', [this.config.depositWallet]);
      logger.info(`[CEA:Bitcoin] Loaded wallet ${this.config.depositWallet}`);
    }

    // Resume from persisted cursor, else start from "now" (skip history)
    if (savedCursor) {
      this.cursor = savedCursor;
      logger.info(`[CEA:Bitcoin] Resuming poll cursor from ${savedCursor.slice(0, 16)}...`);
    } else {
      this.cursor = await this.node.call('getbestblockhash');
      logger.info(`[CEA:Bitcoin] Poll cursor initialized at tip ${this.cursor!.slice(0, 16)}...`);
    }

    this.healthy = true;
  }

  async stop(): Promise<void> {
    this.healthy = false;
    logger.info('[CEA:Bitcoin] Stopped');
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async subscribeBurns(callback: BurnCallback): Promise<void> {
    this.callback = callback;
    logger.info('[CEA:Bitcoin] Deposit callback registered (push channel = blocknotify → checkNow)');
  }

  /** Current poll cursor — persisted by the gateway across restarts. */
  getCursor(): string | null {
    return this.cursor;
  }

  /**
   * Poll from the internal cursor and dispatch every detected deposit
   * through the subscribed callback. Called on a timer AND from the
   * blocknotify push endpoint. Returns the number of events dispatched.
   */
  async checkNow(): Promise<number> {
    if (this.checking) return 0;   // a blocknotify racing the timer is fine — skip
    this.checking = true;
    try {
      const { burns, nextRef } = await this.pollBurns(this.cursor);
      this.cursor = nextRef;
      if (this.callback) {
        for (const burn of burns) {
          await this.callback(burn);
        }
      }
      return burns.length;
    } finally {
      this.checking = false;
    }
  }

  /**
   * Pull-based detection: `listsinceblock` on the watch-only deposits wallet.
   *
   * target_confirmations = finalityConf keeps `lastblock` lagging the tip by
   * the finality window, so recent txs are re-reported each poll until they
   * reach finality — which is exactly the confidence-upgrade re-emission the
   * DUA router (and our gateway dedup) expects. Unconfirmed mempool receives
   * are always included by Core, giving 'mempool' confidence for the UX.
   */
  async pollBurns(sinceRef: string | null): Promise<{
    burns: NormalizedBurnEvent[];
    nextRef: string;
  }> {
    try {
      const ref = sinceRef ?? await this.node.call<string>('getbestblockhash');
      const result = await this.wallet.call('listsinceblock', [
        ref,
        Math.max(1, this.config.finalityConf),
        true,   // include_watchonly
      ]);

      const burns: NormalizedBurnEvent[] = [];
      for (const tx of result.transactions || []) {
        if (tx.category !== 'receive') continue;
        // Never treat a replaced/abandoned tx as a deposit
        if (tx.abandoned === true || tx['bip125-replaceable'] === 'yes' && tx.confirmations === 0 && tx.walletconflicts?.length) continue;

        const confirmations: number = tx.confirmations ?? 0;
        if (confirmations < 0) continue;   // conflicted (reorged out)

        const confidence = this.confidenceFor(confirmations);
        burns.push({
          chain: 'bitcoin',
          burnTxId: `${tx.txid}:${tx.vout}`,
          grossAmount: btcToSats(tx.amount),
          netAmountSoq: 0n,           // receipt mint is carrier+tag, resolved by the gateway (Day 2)
          feeAmount: 0n,
          recipientSoq: '',           // bound via intent (deposit addr ↔ ssq addr); resolved by the gateway
          nonce: tx.vout,
          confidence,
          detectedAt: Date.now(),
          finalizedAt: confidence === 'finalized' ? Date.now() : null,
          rawMeta: {
            txid: tx.txid,
            vout: tx.vout,
            address: tx.address,
            label: tx.label,
            confirmations,
            blockhash: tx.blockhash,
            blockheight: tx.blockheight,
            network: this.config.network,
          },
        });
      }

      this.healthy = true;
      // lastblock is always present in listsinceblock responses
      return { burns, nextRef: result.lastblock || ref };
    } catch (err: any) {
      logger.error(`[CEA:Bitcoin] Poll error: ${err.message}`);
      this.healthy = false;
      return { burns: [], nextRef: sinceRef || '' };
    }
  }

  /**
   * On-chain verification of a specific deposit output before any mint.
   * burnTxId format: `txid:vout`.
   */
  async verifyBurn(burnTxId: string): Promise<VerifyResult> {
    const [txid, voutStr] = burnTxId.split(':');
    if (!txid || txid.length !== 64) {
      return { valid: false, confidence: 'mempool', error: `Malformed deposit id: ${burnTxId}` };
    }
    try {
      const tx = await this.wallet.call('gettransaction', [txid, true]);
      const confirmations: number = tx.confirmations ?? 0;
      if (confirmations < 0) {
        return { valid: false, confidence: 'mempool', error: 'Transaction conflicted (reorged out)' };
      }
      // The named output must be a receive into our deposits wallet
      const vout = parseInt(voutStr ?? '', 10);
      const detail = (tx.details || []).find(
        (d: any) => d.category === 'receive' && d.vout === vout
      );
      if (!detail) {
        return { valid: false, confidence: 'mempool', error: `No receive output at ${burnTxId}` };
      }

      let blockHeight: number | undefined;
      if (tx.blockhash) {
        const header = await this.node.call('getblockheader', [tx.blockhash]);
        blockHeight = header.height;
      }

      return {
        valid: confirmations > 0,
        confidence: this.confidenceFor(confirmations),
        confirmations,
        blockHeight,
        ...(confirmations === 0 ? { error: 'Unconfirmed — awaiting inclusion' } : {}),
      };
    } catch (err: any) {
      return { valid: false, confidence: 'mempool', error: err.message };
    }
  }

  /**
   * SPV merkle-inclusion proof for a confirmed deposit (DL §4.1 —
   * "don't trust, verify"). Self-checked with verifytxoutproof before
   * being handed to anyone. Returns null while unconfirmed.
   */
  async getSpvProof(txid: string, blockhash?: string): Promise<string | null> {
    try {
      const proof: string = await this.node.call(
        'gettxoutproof',
        blockhash ? [[txid], blockhash] : [[txid]]
      );
      const verified: string[] = await this.node.call('verifytxoutproof', [proof]);
      if (!verified.includes(txid)) {
        logger.error(`[CEA:Bitcoin] SPV proof self-check FAILED for ${txid.slice(0, 16)}...`);
        return null;
      }
      return proof;
    } catch {
      return null;   // typically: tx not yet in a block
    }
  }

  /** Fresh P2TR deposit address from the watch-only wallet (no address reuse — DL §4.3). */
  async deriveDepositAddress(label: string): Promise<string> {
    return this.wallet.call<string>('getnewaddress', [label, 'bech32m']);
  }

  /** Vault balance (watch-only deposits wallet), in satoshis. */
  async getVaultBalance(): Promise<{ confirmedSats: bigint; pendingSats: bigint }> {
    const balances = await this.wallet.call('getbalances');
    const mine = balances.mine || {};
    return {
      confirmedSats: btcToSats(mine.trusted ?? 0),
      pendingSats: btcToSats(mine.untrusted_pending ?? 0),
    };
  }

  /** Current chain height (for status surfaces). */
  async getBlockHeight(): Promise<number> {
    const info = await this.node.call('getblockchaininfo');
    return info.blocks;
  }

  private confidenceFor(confirmations: number): BurnConfidence {
    if (confirmations <= 0) return 'mempool';
    if (confirmations >= this.config.finalityConf) return 'finalized';
    return 'confirmed';
  }
}
