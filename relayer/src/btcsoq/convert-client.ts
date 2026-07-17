/**
 * Client for the PRODUCTION signer's treasury quick-swap (convert) engine —
 * the consensus-USDSOQ hop of the BTCSOQ line (WS2, DL-BTCSOQ-MIAMI §3).
 *
 * The gateway is a plain convert customer, exactly like the live relayer's
 * swap flow: it deposits SOQ to the treasury address and calls
 * /api/v1/convert with the deposit txid. The DEPOSIT IS THE AUTH — the
 * engine verifies the on-chain deposit itself (re-checks unspent + confs,
 * resolves the vout by witness program) and pays USDSOQ from treasury
 * inventory. Idempotent per deposit outpoint on the signer side, so the
 * execute call is retry-safe. Authority keys are never in this path
 * (conversions move inventory; only supply changes need authority).
 */

export type ConvertDirection = 'soq_to_usdsoq' | 'usdsoq_to_soq';

export interface ConvertQuote {
  direction: ConvertDirection;
  amount_in: number;      // shors of the input asset
  amount_out: number;     // shors of the output asset (after spread)
  price_usd: number;
  spread_bps: number;
  deposit_addr: string;   // treasury address to deposit to
  note: string;
}

export interface ConvertResult {
  payout_txid: string;
  direction: ConvertDirection;
  amount_in: number;
  amount_out: number;
  idempotent: boolean;    // true if this deposit was already paid out
}

export interface ConvertClientConfig {
  url: string;    // production signer base URL
  token: string;  // SOQ_SIGNER_TOKEN
}

export class ProdConvertClient {
  constructor(private config: ConvertClientConfig) {}

  async quote(direction: ConvertDirection, amountIn: number): Promise<ConvertQuote> {
    return this.request(
      'GET',
      `/api/v1/convert/quote?direction=${direction}&amount_in=${amountIn}`,
      undefined,
      15_000,
    );
  }

  /**
   * Execute a conversion for a confirmed treasury deposit. The engine
   * resolves the deposit vout itself; passing 0 is fine (it is ignored).
   */
  async execute(direction: ConvertDirection, depositTxid: string, toAddress: string): Promise<ConvertResult> {
    return this.request('POST', '/api/v1/convert', {
      direction,
      deposit_txid: depositTxid,
      deposit_vout: 0,
      to_address: toAddress,
    }, 60_000);
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
        throw new Error(`convert non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      if (!resp.ok) {
        throw new Error(`convert ${path.split('?')[0]} HTTP ${resp.status}: ${data.error || text.slice(0, 200)}`);
      }
      return data;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`convert ${path.split('?')[0]} timed out after ${timeoutMs}ms (execute is idempotent per deposit — safe to retry)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
