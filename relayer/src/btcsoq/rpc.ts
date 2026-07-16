/**
 * Minimal Bitcoin Core JSON-RPC client (testnet4 / regtest).
 *
 * Bitcoin Core shares the JSON-RPC shape with soqucoind (common Dogecoin/
 * Bitcoin Core lineage), so this mirrors the cold-node RPC pattern used in
 * watchers/soqucoin.ts — basic-auth POST, error surfaced from data.error.
 *
 * BTCSOQ gateway: DL-BTC-SOQTEC-GATEWAY-2026-07-16.md §5
 */

export interface BitcoinRpcOptions {
  url: string;          // e.g. http://127.0.0.1:48332
  user: string;
  pass: string;
  wallet?: string;      // routes calls to /wallet/<name>
  timeoutMs?: number;
}

export class BitcoinRpc {
  private opts: BitcoinRpcOptions;

  constructor(opts: BitcoinRpcOptions) {
    this.opts = { timeoutMs: 30000, ...opts };
  }

  /** New client bound to a specific wallet endpoint. */
  forWallet(wallet: string): BitcoinRpc {
    return new BitcoinRpc({ ...this.opts, wallet });
  }

  async call<T = any>(method: string, params: any[] = []): Promise<T> {
    const base = this.opts.url.replace(/\/+$/, '');
    const url = this.opts.wallet
      ? `${base}/wallet/${encodeURIComponent(this.opts.wallet)}`
      : base;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs!);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(
            `${this.opts.user}:${this.opts.pass}`
          ).toString('base64'),
        },
        signal: ctrl.signal,
        body: JSON.stringify({ jsonrpc: '1.0', id: `btcsoq-${Date.now()}`, method, params }),
      });

      const text = await resp.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`bitcoind RPC non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      if (data.error) {
        throw new Error(`bitcoind RPC ${method} error ${data.error.code}: ${data.error.message}`);
      }
      return data.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convert a Bitcoin Core BTC-denominated JSON number to integer satoshis. */
export function btcToSats(btc: number): bigint {
  // Core serializes amounts as fixed 8-decimal values; round kills float dust.
  return BigInt(Math.round(btc * 1e8));
}
