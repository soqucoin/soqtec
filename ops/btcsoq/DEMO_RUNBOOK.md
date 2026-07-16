# BTCSOQ Demo Runbook — Miami (Mining Disrupt)

The lane being demonstrated: real testnet4 Bitcoin in, a post-quantum receipt
on Soqucoin stagenet, real Bitcoin back out, every step signed with ML-DSA-44
and verifiable in the audience's own browsers.

Public URL: **https://soqtec.soqu.org/btcsoq.html**
Public API: **https://soqtec-relay.soqu.org/api/btc/gateway**

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
- [ ] Open the page, press **Verify all signatures**, see the green check.
- [ ] testnet4 block cadence sanity: if the chain has been stuck for hours,
      lead with the recorded loop and let live deposits confirm in the background.

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
