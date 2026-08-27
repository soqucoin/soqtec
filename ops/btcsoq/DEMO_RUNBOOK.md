# BTCSOQ Demo Runbook — Miami (Mining Disrupt)

The lane being demonstrated: real testnet4 Bitcoin in, a post-quantum receipt
on Soqucoin stagenet, then the ECONOMY legs — the receipt's loop converts into
consensus-enforced USDSOQ via the treasury swap, pays a post-quantum Lightning
invoice, and an AI answers for the money (SOQ-402) — then real Bitcoin back
out. Every step signed with ML-DSA-44 and verifiable in the audience's own
browsers, including the seller's signed inference receipt.

Stage view for the projector: **https://soqtec.soqu.org/btcsoq.html?stage**
(dark, oversized, event toasts; the plain URL is the attendee/phone view).

**DEMO FRONT DOOR: https://soqtec.soqu.org/live.html — the three doors (pick
your proof).** Act A: Bitcoin buys a thought (402 paywall → Lightning pays in
~30 ms → AI answers → receipt verifies in the viewer's browser). Act B:
machines doing business (Ada and Bit negotiate, every reply bought). Act C:
the race (10 real Lightning payments vs Bitcoin's live block clock). Each act
runs the REAL rails per press. Lead with a door; the proof page is for the
skeptics afterward.

Proof page: **https://soqtec.soqu.org/btcsoq.html**
Public API: **https://soqtec-relay.soqu.org/api/btc/gateway**

Theater pre-flight (T-60, in addition to the checks below): open live.html,
run each act once. Budget notes: acts spend from the gateway payer channel
(ask 333 shors, duel ~1.3K, race 10K); daily caps ask 500 / duel 60 /
race 100 (in-memory, reset on relayer restart). Both agents must 402:
Ada :4020 AND Bit :4021.

## Pre-demo checklist (T-60 min, all on Services VPS 143.110.229.69)

```bash
systemctl is-active btcsoq-relayer-t4 btcsoq-signer bitcoind-testnet4 soqucoind-stagenet electrumx
curl -s https://soqtec-relay.soqu.org/api/btc/gateway | jq '.gateway | {healthy, moneyLoop, breaker}'
```

- [ ] `healthy: true`, `moneyLoop: true`, `breaker.paused: false`, `porHalted: false`
- [ ] **No pause file**: `ls /opt/btcsoq-dev/data-t4/PAUSE` should say No such file
- [ ] **BTC release float** covers expected redemptions (each redemption pays out
      what was deposited, from this float):
      `bitcoin-cli -testnet4 -rpcwallet=btcsoq-release getbalances` (creds: `/root/.btcsoq-rpc.env`)
- [ ] **SOQ mint float** (each receipt costs a 0.2 SOQ carrier + ~0.05-0.08 SOQ fee):
      `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8562/api/v1/balance`
      (token: `/var/lib/btcsoq-signer/secrets.env`; 100+ SOQ confirmed = dozens of mints)
- [ ] **Float is PRE-SPLIT into multiple UTXOs** (`utxo_count` in the balance
      response, want 4+): consecutive mints on one UTXO chain serialize behind
      3-conf change (~2-4 min per mint); parallel UTXOs = parallel mints. Top
      up with several separate sends from the production signer, never one.
- [ ] Daily caps sized for the audience: t4 defaults are 5,000,000 sats each
      direction per 24h. Raise via `BTCSOQ_MAX_DAILY_MINT_SATS` /
      `BTCSOQ_MAX_DAILY_RELEASE_SATS` in `/opt/btcsoq-dev/relayer/t4.env`
      + `systemctl restart btcsoq-relayer-t4` if the crowd will exceed that.
- [ ] **STANDING FLOAT — the RECEIPT station must never read 0 on demo day.**
      If everything has been redeemed, run one loop the morning of and leave
      the receipt outstanding (deposit, let it mint, do NOT redeem). A zero
      marquee metric reads as "nobody uses this."
- [ ] **Warm the feed the morning of**: the newest ledger row should be hours
      old, not weeks. One fresh loop covers this and the standing-float rule
      at the same time.
- [ ] **USDSOQ leg** (`gateway.conversions` in the status JSON): quote must
      answer — `curl -s -H "Authorization: Bearer $SOQ_SIGNER_TOKEN"
      "http://64.23.129.28:8550/api/v1/convert/quote?direction=soq_to_usdsoq&amount_in=300000000000"`.
      The engine enforces a $1 minimum PER SWAP at execute time; the per-loop
      size (`BTCSOQ_CONVERT_SHORS`, currently 3,000 SOQ) must be worth over
      $1 at the live DexScreener price — re-check if SOQ moved. Mint float
      must cover (conversions spend gateway float SOQ; ~22K SOQ loaded 7/16,
      top up from the prod signer with SEPARATE sends of ≤10K SOQ each,
      field name is "address" on the prod /send).
- [ ] **Lightning/402 leg** (`gateway.ln402`): seller must 402 —
      `curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json"
      -d '{"messages":[{"role":"user","content":"ping"}],"max_tokens":10}'
      http://127.0.0.1:4020/v1/chat/completions` → expect 402. LSP healthy:
      `curl -s https://lsp.soqu.org/v1/health`. Channel state lives at
      `/opt/btcsoq-dev/data-t4/ln-channel.json` (auto-reopens if closed;
      LSP faucet may be at capacity — the plain open fallback handles it).
- [ ] Open the page and watch the ledger rows verify THEMSELVES (green
      checkmarks appear as the feed loads — there is no verify button; the
      manual reproduction snippet is printed under the table). The latest
      AI answer block must show "seller receipt ML-DSA-44 verified".
- [ ] testnet4 block cadence sanity: if the chain has been stuck for hours,
      lead with the recorded loop and let live deposits confirm in the background.

## The miner beat (WS6) and the Bitcoin anchor (WS4)

**Miner beat, the line for the room:** "You already own the hardware. Point
your pool payouts at a boundary address and every payout crosses on arrival:
quantum-safe receipt, automatic, provable, and the coins go home whenever you
say." Live once per show: create a deposit intent, send a payout-sized
testnet4 amount to it from the release wallet, and let the room watch the
crossing fire the whole line on its own (mint → USDSOQ → paid AI answer, all
attested, all on the terminal tape). Proven 7/17: payout e4fdfae2… →
intent ac8635a4.

**Bitcoin anchor, the line for the room:** "The fortress's books are
notarized by Bitcoin itself." The ledger's merkle root goes into a testnet4
OP_RETURN hourly whenever the ledger changed (BSQA payload; recipe in the
gateway API). Pre-demo T-60: force a fresh anchor so the page shows a
minutes-old notarization:
`curl -s -X POST "http://127.0.0.1:3006/api/btc/anchor?force=1"` (localhost).
First anchor 7/17: tx 016b17638dba… root 5e7d3233… (6 events), byte-verified
on mempool.space.

## Run of show (attendee path)

1. Attendee opens the page, reads the four-step strip.
2. Attendee needs an ssq address: **SoquShield, fresh receive address** (fresh
   matters: the receipt should be the only coin there, so the redemption spend
   naturally consumes it).
3. Deposit panel → paste ssq address → fresh tb1p deposit address appears.
   Send from any testnet4 wallet/faucet (minimum 10,000 sats).
4. Status flips deposit-seen instantly; at one confirmation the mint fires and
   the mint tx id appears. Two new rows land in the attestation feed.
5. Press **Verify** on the new rows. The point to say out loud: the signature
   check is running in *your* browser against the published public key; the
   page is not asserting anything you cannot re-derive.
6. Redeem panel → same ssq address + their tb1 payout address → send the
   receipt coin to the redemption address shown → release tx appears, BTC
   arrives, PoR strip returns to covered.

## The honest pitch (keep to this framing, WRITING_RULES applies)

"Bitcoin's own signatures are classical. While your BTC sits behind this
gateway, taking your position requires forging a NIST post-quantum signature."
Custodial pilot, overlay receipt, testnet only: all disclosed on the page.
Do not improvise trustless/bridge-to-mainnet claims.

## Failure fallbacks (in order)

1. **testnet4 not producing blocks**: deposits sit at deposit-seen. Narrate it
   honestly ("public test network, blocks are sparse") and pivot to the
   attestation feed + PoR of already-completed loops; the pending mint fires
   on its own mid-demo, which reads well.
2. **Something misbehaving with money**: pause it —
   `touch /opt/btcsoq-dev/data-t4/PAUSE`. Everything defers (nothing fails,
   nothing is lost); page shows the breaker state. `rm` the file to resume,
   deferred work completes automatically.
3. **Public page/API down**: the regtest lane (`:3005` on the VPS) is the
   rehearsal harness — `bash /root/e2e-regtest-day2.sh` runs the entire loop
   scripted, 30 checks, on demand.
4. **Total loss**: the recorded fallback video (Day-4 item, record during
   rehearsal: one full loop on the public page, deposit through release,
   including a Verify click).

## Emergency contacts / paths

- Relayer logs: `journalctl -u btcsoq-relayer-t4 -f`
- Signer logs: `journalctl -u btcsoq-signer -f`
- Gateway state file: `/opt/btcsoq-dev/data-t4/btcsoq-state.json` (do not edit
  live; stop the service first, and never delete: the ledger CAS lives here)
- The receipt ledger is rebuildable from chain: every mint tx carries the BSQ1
  tag, so a lost state file is recoverable (scan for `6a31` OP_RETURNs with
  prefix `42535131`).
