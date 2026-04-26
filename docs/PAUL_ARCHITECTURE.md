# Quantum Express — UTXO Architecture Brainstorm
*Buddy / Antigravity — Apr 26, 2026*

---

## The Real Problem

The current QE flow works logically but fails on latency:

```
Solana burn detected (instant)
  → relayer calls sendtoaddress on soqucoind
    → soqucoind scans 180K UTXOs for coin selection  ← 8-MINUTE BOTTLENECK
      → signs, broadcasts, confirms
```

The hot wallet "fix" is a band-aid: small UTXO set = fast selection, but it can run dry and is centralized. The QE patent claim is supposed to be **express** — sub-minute, ideally sub-10-second.

**Core UTXO insight**: In account-model chains (Solana, Ethereum), `balance -= amount` is one state update. In UTXO, you must *SELECT* specific unspent coins, create new outputs, and sign. The bottleneck is always UTXO selection at scale.

---

## The Requirement Triangle

| Requirement | Why it matters |
|---|---|
| **Agnostic** | Should work on Bitcoin, Dogecoin, Litecoin, any UTXO L1 |
| **Secure** | Bridge funds must be quantum-safe, multi-sig, auditable |
| **Express** | Sub-10-second release after burn detection |
| **Auditable** | Any auditor can verify every release maps to a specific burn |
| **Robust** | No single point of failure; degrade gracefully under load |

These five requirements together rule out the simple approaches and point toward a specific architecture.

---

## What Doesn't Work (and Why)

### ❌ Naive sendtoaddress
Already proven: 8+ minutes at 180K UTXOs. Gets worse as the wallet ages.

### ❌ Hot wallet (current)
Fast until empty. Requires off-chain refill logic. Centralized key risk.
Not auditable as a standalone mechanism (refill txns obscure the burn→release linkage).

### ❌ Lightning-style payment channels
Requires protocol-level support. SOQ has PAT opcodes but no full LN daemon.
Overkill for a bridge — channels need both parties online, funding rounds, etc.

### ❌ Pure atomic swap (HTLC)
Correct trust model, but requires the recipient to know they're getting SOQ **before** they burn pSOQ. Chicken-and-egg. Also: HTLCs on Solana require the user to actively claim, breaking the "express" UX of automatic release.

---

## The Real Insight: UTXO Selection IS the Problem

Everything else (signing, broadcasting, confirming) is fast. The ONLY bottleneck is:
> "Which coins do I spend, and in what combination, to produce the exact output amount?"

This is the **coin selection problem**. The wallet solves it at call time by scanning all UTXOs. With 180K UTXOs, that's slow.

**The solution: eliminate coin selection at release time by doing it in advance.**

---

## Option A: Pre-Allocated UTXO Lanes (PAUL)

> Think of it like highway denominations. Pre-fund "lanes" for common amounts so any release is just "pick the matching lane and broadcast."

### How it works

```
Cold Wallet (custody)
    ↓ (background, off-peak)
Lane Manager (daemon)
    ↓
Lane Pool (on-chain UTXOs, confirmed, pre-indexed):
  [50 SOQ lane]  → [UTXO ready] [UTXO ready] [UTXO ready]
  [100 SOQ lane] → [UTXO ready] [UTXO ready]
  [500 SOQ lane] → [UTXO ready]
  [1K SOQ lane]  → [UTXO ready] [UTXO ready]
  ...
    ↓ (at burn time, sub-second)
Relayer: burn = 50 pSOQ → pick from [50 SOQ lane] → broadcast pre-selected UTXO → done
```

### Why it works for UTXO

At release time, the relayer doesn't do coin selection. It just:
1. Looks up the right lane for the requested amount
2. Signs a single UTXO spend (already pre-selected in the pool) to the recipient
3. Broadcasts

Signing is ~1ms. Broadcasting is ~100ms. **Total release time: <1 second.**

### Denominations

Bridge amounts aren't always round numbers. Two strategies:

**Strategy 1 — Rounding with change output:**
- Round DOWN to nearest lane denomination
- Issue a second UTXO for the remainder (small, fast)
- User gets two UTXOs but the "express" lane covers the bulk amount instantly

**Strategy 2 — Make + Break:**
- If no exact denomination exists, break a larger UTXO into the needed amount
- Pre-do the breaking during the background refill cycle, not at release time

### Auditability

Each lane UTXO's creation TX is traceable back to the bridge multisig funding address.
At release time: `[Solana burn txid] → [SOQ release txid] → [lane UTXO source txid]`
Every link in the chain is on-chain and verifiable.

### Security

Lane UTXOs are held in a **threshold multisig address** (e.g., 2-of-3 ML-DSA-44 keys). The relayer holds only one key. Releases require the relayer key + an automated co-signer (HSM or threshold service). A compromised relayer cannot unilaterally drain lanes.

### Robustness

- If a lane is empty, queue the request with a guaranteed SLA (e.g., "within 3 blocks")
- Lane refiller runs as a systemd service, triggered when any lane drops below N UTXOs
- Lane refiller uses the cold wallet (slow is OK — it runs in background, not on critical path)

### Chain Agnosticism

This works identically on Bitcoin, Dogecoin, Litecoin, Soqucoin. The "lane" concept is pure UTXO — just a database of `(txid, vout, amount, status)` tuples. The signing uses whatever key format the chain requires (Dilithium for SOQ, ECDSA for BTC, etc.).

---

## Option B: Deterministic UTXO Assignment (DUA)

> The deeper idea: what if you could PREDICT which UTXO will serve each burn event, before the burn even happens?

### How it works

Use the Solana burn parameters to **deterministically derive** a receiving address:

```
bridge_key = master HD key (BIP32)
burn_id = SHA256(solana_program_id || burn_slot || burn_amount || recipient_soq_address)
release_key = HMAC(bridge_key, burn_id)   ← deterministic, reproducible
release_address = P2TR(release_key)        ← on Soqucoin L1
```

**Pre-fund** the release address when the bridge detects the pSOQ burn transaction on Solana. The release address is already funded *before* the Solana burn is even finalized.

### Flow

```
1. User initiates bridge: submits {soq_address, amount} to relayer
2. Relayer computes release_address = derive(burn_params)
3. Relayer pre-funds release_address from hot pool (instant)
4. Relayer returns: "burn this pSOQ — your SOQ is pre-allocated at block N"
5. User burns pSOQ on Solana
6. Relayer detects burn, verifies params match, marks release_address as spendable
7. Recipient can now spend release_address immediately
```

### Why this is powerful

- **No coin selection at release time** — the UTXO is ALREADY sitting at the release address
- **Pre-funded before the Solana burn** — the "express" is actually front-running the burn
- **Atomic-ish**: if the user doesn't burn within timeout, the pre-funded address is reclaimed
- **Auditable**: `burn_id` → `release_address` is a deterministic, reproducible computation any auditor can verify independently

### Risk

If the user never burns (they see the pre-funded address and try to claim), they can't — the private key for the release address is held by the bridge. The UTXO is only spendable via the bridge's signature.

### Patent angle

This is the "Quantum Express" claim in a more formal sense:
> *A deterministic UTXO assignment protocol where cross-chain release funds are pre-committed to a cryptographically-derived output address before the source-chain burn transaction is finalized.*

That's a novel claim. Bitcoin bridges (tBTC, Wormhole) don't pre-derive and pre-fund.

---

## Option C: Burn-Receipt Oracle + Covenant Script

> The most trust-minimized option — use Soqucoin's PAT opcodes to make the UTXO itself verify the Solana burn.

### How it works

Fund a special script output (using PAT) that can ONLY be spent if:
1. A valid Solana burn receipt (signed by the relayer quorum) is provided in the scriptSig
2. The spend is to the address encoded in the burn receipt

```
Script (pseudo-PAT):
  OP_PUSH <relayer_quorum_pubkey>
  OP_PUSH <burn_receipt_hash>
  OP_CHECKBURNRECEIPT      ← custom PAT opcode
  OP_CHECKSIGQUORUM        ← 2-of-3 ML-DSA-44
```

### Why this is the "right" answer architecturally

This eliminates the relayer as a trust assumption:
- The UTXO can ONLY be released to the correct recipient
- The correctness proof is on-chain, not off-chain
- Any node can independently verify the burn happened (oracle quorum signs the Solana state)

### Reality check

This requires:
1. A new PAT opcode (`OP_CHECKBURNRECEIPT`) — doable but needs a consensus upgrade + activation
2. An oracle network that attests to Solana state — same design as most production bridges (Wormhole, Axelar)
3. Full implementation: ~4-6 weeks of engineering

This is **Phase 2 / mainnet-ready design**. Not for the hackathon but describes where QE evolves.

---

## Recommended Path: PAUL + DUA Hybrid

For **now (hackathon)**:
- PAUL lanes for common amounts (50, 100, 500 SOQ)
- DUA for custom amounts (derive-and-prefund pattern)
- Hot wallet is just the funding source for PAUL lanes (nothing changes in infra)
- Express time: <2 seconds

For **mainnet**:
- Phase 1: PAUL + DUA (trust = relayer quorum, same as all production bridges today)
- Phase 2: PAT covenant script (trust = oracle quorum, same as Wormhole)
- Phase 3: Full covenant with Solana light client proof (trustless — this is where the patent really shines)

---

## Implementation Plan (PAUL — Hackathon Scope)

### New service: `soqtec-lane-manager`

```
/usr/local/bin/soqtec-lane-manager.py
```

**Responsibilities:**
1. Maintain a SQLite DB of lane UTXOs: `(txid, vout, amount, status, created_at)`
2. On startup: scan wallet for unspent, classify into lanes
3. Background: when any lane drops below `min_depth` UTXOs, refill from hot wallet
4. API: `reserve(amount)` → returns `{txid, vout, signing_key_path}` in <1ms
5. API: `release(txid, vout, recipient, relayer_sig)` → broadcasts pre-built tx

### Relayer changes (minimal)

Replace `sendtoaddress(recipient, net_amount)` with:
```js
const utxo = await laneManager.reserve(netAmount)  // instant
const rawTx = buildTx(utxo, recipient, netAmount)   // instant
const signedTx = sign(rawTx, hotKey)                // ~1ms
const txid = await broadcastTx(signedTx)             // ~100ms network
```

### Denominations for SOQ bridge

Start with: `[9, 10, 50, 100, 500, 1000, 5000, 10000]`
(9 = heartbeat, 50 = common QE demo amount)
Min pool depth per lane: 5 UTXOs
Refill trigger: depth < 3

---

## The Patent Angle (Quantum Express, #64/035,873)

The innovative claim that makes QE novel vs every existing bridge:

> **Claim**: A method for quantum-safe cross-chain asset transfer using pre-allocated, cryptographically-committed UTXO outputs on a hash-based-signature L1, where release funds are deterministically reserved prior to source-chain burn finalization, eliminating coin selection latency and enabling sub-second UTXO settlement.

Why this is unique:
- tBTC: uses ECDSA, threshold signing, but NOT pre-allocated — still does coin selection
- Wormhole: account model on both sides, UTXO problem doesn't apply
- Lightning: requires channels, both parties online, not a bridge
- RenVM: custodial, ECDSA, no pre-allocation

**SOQ-TEC QE is the first** to specifically address UTXO coin-selection latency as a first-class bridge design problem, with a cryptographic pre-allocation solution.

---

## Questions for Casey

1. **Denomination floor**: What's the smallest bridge amount we want to support? (affects lane design)
2. **Lane funding source**: Should PAUL lanes be funded from the hot wallet directly, or separately from cold?
3. **DUA timeline**: Is pre-funding-before-burn acceptable UX? (user would submit bridge intent, then burn within a time window)
4. **Oracle Phase 2**: Is building a lightweight Solana state oracle realistic for mainnet? Or do we rely on relayer quorum long-term?
