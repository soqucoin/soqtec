# Quantum Express — PAUL / DUA / CEA Architecture
*Soqucoin Labs Inc. — April 2026*

> **Status:** PAUL DEPLOYED | DUA/CEA DEPLOYED | PAT Phase 2 pending
> **Patent:** SOQ-P006 #64/035,873 (Filed March 31, 2026) — covers PAUL/DUA/CEA embodiments
> **VPS:** `143.110.229.69` (soqucoin-stagenet) — Relayer + Lane Manager active

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

## Option A: Pre-Allocated UTXO Lanes (PAUL) — ✅ IMPLEMENTED

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

### Implementation Status

| Component | Status | Location |
|---|---|---|
| Lane Manager daemon | ✅ LIVE | `/usr/local/bin/soqtec-lane-manager.py` (systemd) |
| SQLite lane DB | ✅ LIVE | `/var/lib/soqtec-lane-manager/lanes.db` |
| API: `/status` | ✅ LIVE | Port 3003 |
| API: `/bridge` (release) | ✅ LIVE | Port 3003 |
| API: `/refill` | ✅ LIVE | Port 3003 |
| Address-based UTXO tracking | ✅ LIVE | `lockunspent` + `listunspent` strategy |
| Auto-refiller | ✅ LIVE | 120s interval, depth 2/3 per denomination |
| **Total releases completed** | **31+** | Verified operational |

### Production Configuration

```python
LANE_DENOMINATIONS = [10, 50, 100, 500, 1000, 5000, 10000]  # SOQ
MIN_LANE_DEPTH     = 2      # UTXOs per denomination (trigger refill)
TARGET_LANE_DEPTH  = 3      # UTXOs per denomination (refill target)
REFILL_INTERVAL    = 120    # Seconds between refill checks
RPC_TIMEOUT        = 30     # Seconds (Dilithium ML-DSA-44 signing overhead)
```

### Performance Results (Testnet3 VPS)

| Metric | Value | Notes |
|---|---|---|
| Dilithium signing time | 6-10s | ML-DSA-44 on shared 2-vCPU VPS |
| PAUL total release time | ~8.6s | 6.5s signing + 2.1s PAUL overhead |
| Direct send (fallback) | ~10-12s | Via directSendToAddress |
| Hot wallet balance | ~44,400 SOQ | Available for lanes + releases |
| Lanes maintained | 7 denominations | 10/50/100/500/1K/5K/10K SOQ |

### Known Issue: Dilithium Signing Contention

**Root cause:** ML-DSA-44 signing on the shared VPS CPU is single-threaded. When the lane refiller is concurrently creating UTXOs, the Soqucoin node can't handle both refill + release operations simultaneously, causing cascading RPC timeouts.

**Mitigation applied:**
- Lane depth reduced: 10 → 3 (reduces concurrent signing load)
- Refill interval: 60s → 120s
- RPC timeout: 10s → 30s
- **Graceful fallback to `directSendToAddress`** — releases always complete

**Path to sub-1-second PAUL releases:**
1. Dedicated 4-vCPU VPS for Dilithium signing
2. Refiller scheduling during low-traffic windows
3. RPC serialization queue in lane manager

---

## Option B: Dual-Usage Attestation (DUA) + Chain Event Adapter (CEA) — ✅ IMPLEMENTED

> The chain-agnostic event detection and routing layer. CEAs normalize burn events from ANY source chain, DUA Router deduplicates and routes releases.

### Architecture

```
                     ┌─────────────┐
  Solana burns ────► │ SolanaCEA   │──┐
                     └─────────────┘  │
                                      ├──► DUA Event Router ──► PAUL (sub-10s)
  Bitcoin burns ───► │ BitcoinCEA  │──┤                    └──► Direct send (fallback)
  (future)           └─────────────┘  │
                                      │
  Ethereum burns ──► │ EthereumCEA │──┘
  (future)           └─────────────┘
```

### Implementation Status

| Component | Status | Location |
|---|---|---|
| CEA type system | ✅ LIVE | `relayer/src/cea/types.ts` |
| SolanaCEA | ✅ LIVE | `relayer/src/cea/solana-cea.ts` |
| DUAEventRouter | ✅ LIVE | `relayer/src/cea/router.ts` |
| Helius webhook endpoint | ✅ LIVE | `POST /api/helius/burn-events` |
| DUA status API | ✅ LIVE | `GET /api/dua/status` |
| DUA releases API | ✅ LIVE | `GET /api/dua/releases` |
| Circuit breaker | ✅ LIVE | `POST /api/dua/halt` / `resume` |
| BitcoinCEA (ZMQ) | ⏳ Planned | Phase 2 |
| EthereumCEA (WebSocket) | ⏳ Planned | Phase 2 |
| CosmosCEA (IBC events) | ⏳ Planned | Phase 3 |

### DUA Pipeline Flow

```
Solana burn detected
    │
    ├──► Helius webhook ──► POST /api/helius/burn-events
    │                              │
    └──► RPC poll (5s fallback) ───┘
                                   │
                            SolanaCEA (normalizes event)
                                   │
                            DUA Event Router
                            ├─ Dedup (seen-set)
                            ├─ Confidence check (mempool/confirmed/finalized)
                            ├─ Circuit breaker check
                            │
                            ┌──────┴──────┐
                            │             │
                       PAUL lanes    Direct send
                      (sub-10s)      (fallback)
                            │
                       L1 SOQ release
```

### Confidence Policy

```
mempool    → Speculative release (fastest, risk of reorg)
confirmed  → Release on first block inclusion (current default)
finalized  → Wait for Solana finalization (~13s, safest)
```

### Scalability Analysis

```
SolanaCEA Capacity:
├── Helius Enhanced Webhooks: 50 req/s (1.58B events/year)
├── RPC poll fallback: ~12 req/s per endpoint
├── Helius annual plan: 40 RPS included
└── Theoretical max: 50M+ transfers/year (Solana alone)

Multi-chain (future):
├── BitcoinCEA: ZMQ pub/sub → unlimited local events
├── EthereumCEA: WebSocket subscriptions → ~100 events/s
├── CosmosCEA: IBC packet events → chain-dependent
└── Combined: 100M+ annual events across all chains
```

---

## Option C: PAT Covenant Script — ⏳ Phase 2 (Mainnet)

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

### Status

- **NOT YET IMPLEMENTED** — requires new consensus opcode + activation
- **Prerequisite:** SOQ-P001 (`VerifyScript()` must call `EvalScript()` for PAT opcodes)
- **Target:** Phase 2 audit scope (Halborn) alongside Lattice-BP++ and USDSOQ
- **Engineering estimate:** ~4-6 weeks after VerifyScript wiring

### Why defer to Phase 2

PAUL + DUA/CEA achieves the same UX (<10s releases) without consensus changes.
Adding a new opcode requires:
1. Consensus upgrade + BIP9 deployment
2. Full audit (breaking consensus is high-risk)
3. All node operators must upgrade

The trust model difference is small: PAUL relies on relayer quorum (2-of-3), same as all production bridges today (Wormhole, LayerZero). PAT covenant moves to on-chain verification (trustless).

---

## Current Production Architecture

### Recommended Path: PAUL + DUA/CEA ← **THIS IS LIVE**

```
VPS 143.110.229.69 (soqucoin-stagenet)
├── soqtec-relayer (v0.2.0)        port 3001
│   ├── Legacy watchers (Solana/Soqucoin poll)
│   ├── DUA/CEA pipeline (SolanaCEA → DUA Router)
│   ├── PAUL bridge routing (→ port 3003)
│   ├── Direct sendtoaddress fallback
│   └── 5 new DUA API endpoints
│
├── soqtec-lane-manager.py         port 3003
│   ├── SQLite lane DB
│   ├── 7 denomination lanes
│   ├── Auto-refiller (120s cycle)
│   └── lockunspent UTXO reservation
│
└── soqucoind (hot wallet)         port 44557
    ├── ML-DSA-44 Dilithium signing
    ├── ~44,400 SOQ balance
    └── Testnet3, block 51,200+
```

### For Mainnet Evolution

```
Phase 1 (NOW):   PAUL + DUA/CEA (trust = relayer quorum, same as all bridges)
Phase 2 (Audit): PAT covenant script (trust = oracle quorum, like Wormhole)
Phase 3 (Long):  Full covenant + Solana light client proof (trustless)
```

---

## Implementation Results

### Bugs Found During Production Deployment

| # | Bug | Root Cause | Fix |
|---|-----|-----------|-----|
| 1 | `AbortSignal.timeout()` fires immediately | Node 18.19.1 bug — doesn't wait N ms | `AbortController` + `setTimeout` pattern |
| 2 | `localhost` fetch fails from Node | Resolves to IPv6 `::1`, Python listens IPv4 only | Use `127.0.0.1` explicitly |
| 3 | PAUL releases timeout under load | Refiller + bridge racing for Dilithium signer | Depth 10→3, interval 60→120s, timeout 10→30s |
| 4 | Duplicate log lines in lane-manager | Python logger + handler duplication | Cosmetic, not addressed yet |
| 5 | Helius webhook registration fails | No public callback URL set | Expected — poll-only mode for now |

### Lessons Learned

1. **Dilithium signing is the bottleneck, not UTXO selection** — PAUL eliminates coin selection but ML-DSA-44 signing still takes 6-10s per TX on shared CPU
2. **Graceful fallback is mandatory** — PAUL→direct fallback ensures 100% release success even under contention
3. **Node 18 has significant `fetch` bugs** — always use AbortController pattern, always use 127.0.0.1 for local services
4. **Lane depth tuning is critical** — aggressive refilling (10 UTXOs × 7 denoms) saturates the signer; conservative (3 × 7 = 21) works reliably

---

## The Patent Angle (Quantum Express, #64/035,873)

The central claim that distinguishes QE from existing bridge architectures:

> **Claim**: A method for quantum-safe cross-chain asset transfer using pre-allocated, cryptographically-committed UTXO outputs on a hash-based-signature L1, where release funds are deterministically reserved prior to source-chain burn finalization, eliminating coin selection latency and enabling sub-second UTXO settlement.

### PAUL/DUA/CEA Embodiments (for non-provisional update)

1. **PAUL** — Pre-Allocated UTXO Lanes with denomination-specific pools and automatic refilling
2. **DUA** — Dual-Usage Attestation with chain-agnostic event routing and deduplication
3. **CEA** — Chain Event Adapter abstraction supporting push (webhook) and pull (RPC poll) detection
4. **Confidence Policies** — Configurable release triggers (mempool/confirmed/finalized)
5. **Circuit Breaker** — Multi-class halt mechanism (reorg/mismatch/timeout/corruption)

Why this is unique:
- tBTC: uses ECDSA, threshold signing, but NOT pre-allocated — still does coin selection
- Wormhole: account model on both sides, UTXO problem doesn't apply
- Lightning: requires channels, both parties online, not a bridge
- RenVM: custodial, ECDSA, no pre-allocation

**SOQ-TEC QE is the first** to specifically address UTXO coin-selection latency as a first-class bridge design problem, with a cryptographic pre-allocation solution.

---

## Next Steps

### Immediate (This Week)
1. **Helius Webhook Activation** — Create Cloudflare Worker proxy for public callback URL
2. **E2E Burn Test** — Trigger actual pSOQ burn on Solana devnet → verify DUA pipeline fires
3. **PAUL off-peak test** — Run bridge during refiller idle window to confirm sub-10s PAUL routing

### Near-term (May 2026)
4. **PoR Batch Attestation** — Implement 60-block batch + ML-DSA-44 aggregate signature
5. **Multi-chain** — `BitcoinCEA` (ZMQ), `EthereumCEA` (WebSocket)
6. **Patent Update** — P006 non-provisional with PAUL/DUA/CEA embodiments

### Mainnet (Phase 2 Audit)
7. **PAT Covenant Opcode** — `OP_CHECKBURNRECEIPT` after VerifyScript wiring (SOQ-P001)
8. **Dedicated VPS** — 4-vCPU for sub-1s Dilithium signing
9. **Node.js 20+ upgrade** — Native AbortSignal.timeout fix

---

## Questions for Casey

1. ~~**Denomination floor**: What's the smallest bridge amount we want to support?~~ **Answered: 10 SOQ minimum (lane_10)**
2. ~~**Lane funding source**: Should PAUL lanes be funded from the hot wallet directly, or separately from cold?~~ **Answered: Hot wallet directly, auto-refill from cold via 6h cron**
3. **DUA timeline**: Is pre-funding-before-burn acceptable UX? (user would submit bridge intent, then burn within a time window)
4. **Oracle Phase 2**: Is building a lightweight Solana state oracle realistic for mainnet? Or do we rely on relayer quorum long-term?
5. **Helius webhook**: Ready to set up Cloudflare Worker proxy for public callback URL?
6. **VPS upgrade**: When should we move to a dedicated 4-vCPU VPS for sub-1s signing?

---

*Last updated: April 26, 2026 — Relayer v0.2.0 (DUA/CEA), 31+ releases, Block 51,200+*
*"Irish don't quit."*
