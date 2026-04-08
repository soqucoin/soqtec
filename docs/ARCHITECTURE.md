# SOQ-TEC Architecture

> **SOQ-TEC** — Soqucoin Operations for Quantum-Tolerant Ecosystem Custody

---

## Overview

SOQ-TEC is a bidirectional cross-chain bridge connecting Solana (classical Ed25519) to Soqucoin L1 (NIST FIPS 204 ML-DSA-44 Dilithium). It provides quantum-safe custody for Solana-native assets by enabling users to bridge value into a post-quantum L1 for long-term storage, and bridge back when speed and liquidity are needed.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SOQ-TEC BRIDGE                             │
│                                                                     │
│  ┌──────────────────────┐         ┌──────────────────────────────┐  │
│  │    SOLANA SIDE        │         │    SOQUCOIN SIDE              │  │
│  │                      │         │                              │  │
│  │  ┌────────────────┐  │         │  ┌────────────────────────┐  │  │
│  │  │ pSOQ SPL Token │  │         │  │ SOQ-TEC Vault          │  │  │
│  │  │ (1B supply)    │  │         │  │ 3-of-5 Dilithium       │  │  │
│  │  └───────┬────────┘  │         │  │ multisig custody       │  │  │
│  │          │            │         │  └───────────┬────────────┘  │  │
│  │          ▼            │         │              │               │  │
│  │  ┌────────────────┐  │         │              ▼               │  │
│  │  │ Bridge Program │  │         │  ┌────────────────────────┐  │  │
│  │  │ (Anchor/Rust)  │  │         │  │ Vault RPC Wrapper      │  │  │
│  │  │ burn / mint    │  │         │  │ lock / release         │  │  │
│  │  │ circuit breaker│  │         │  │ replay protection      │  │  │
│  │  │ PoR attestation│  │         │  │ 240-block maturity     │  │  │
│  │  └───────┬────────┘  │         │  └───────────┬────────────┘  │  │
│  │          │            │         │              │               │  │
│  └──────────┼────────────┘         └──────────────┼───────────────┘  │
│             │                                     │                  │
│             ▼                                     ▼                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    RELAYER SERVICE (Node.js)                    │  │
│  │                                                                │  │
│  │  Solana Watcher ──► Event Queue ──► Soqucoin Submitter        │  │
│  │                         ↕                                      │  │
│  │                 Validator Signer Pool (3-of-5)                 │  │
│  │                         ↕                                      │  │
│  │  Soqucoin Watcher ──► Event Queue ──► Solana Submitter        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                   SOQ-TEC TERMINAL (Web)                       │  │
│  │   Dashboard — vault balance, bridge activity, PoR, security   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Solana Bridge Program (Anchor/Rust)

The on-chain Solana program manages pSOQ token operations and bridge escrow.

**Key Accounts:**

```rust
#[account]
pub struct BridgeState {
    pub authority: Pubkey,        // Multisig PDA
    pub mint: Pubkey,             // pSOQ mint address
    pub total_burned: u64,        // Cumulative burns (Solana → Soqucoin)
    pub total_minted: u64,        // Cumulative mints (Soqucoin → Solana)
    pub vault_balance: u64,       // Attested SOQ vault balance
    pub paused: bool,             // Circuit breaker
    pub bump: u8,
}
```

**Instructions:**

| Instruction | Direction | Description |
|-------------|-----------|-------------|
| `burn_for_redemption` | SOL → SOQ | Burns pSOQ, emits event for relayer |
| `mint_from_deposit` | SOQ → SOL | Mints pSOQ after relayer verification |
| `update_vault_balance` | — | Updates on-chain PoR from relayer attestation |
| `pause_bridge` / `resume_bridge` | — | Emergency circuit breaker (admin only) |

**Safety Features:**
- Volume-based circuit breaker (max per-epoch)
- Minimum transfer amount (100 SOQ)
- Pause authority for emergency response
- On-chain Proof of Reserves attestation

### 2. Soqucoin Vault (C++)

A 3-of-5 Dilithium multisig custody address on Soqucoin L1.

```
# P2SH-style multisig with Dilithium
OP_3 <pubkey1> <pubkey2> <pubkey3> <pubkey4> <pubkey5> OP_5 OP_CHECKMULTISIG
```

**Properties:**
- All vault operations require 3-of-5 validator signatures
- Dilithium keys are **reusable** (unlike Winternitz one-time keys)
- 240-block maturity requirement before release (replay protection)
- UTXO-based — deterministic, auditable state

### 3. Relayer Service (TypeScript/Node)

The off-chain component that watches both chains and coordinates transfers.

**Flow: Solana → Soqucoin (Burn)**
1. User calls `burn_for_redemption(amount, soq_address)` on Solana
2. Relayer detects `BurnEvent` from Solana program logs
3. Relayer constructs Soqucoin release transaction
4. 3-of-5 validators sign the release
5. Transaction submitted to Soqucoin L1
6. After 240-block maturity, SOQ released to user's Dilithium address

**Flow: Soqucoin → Solana (Lock)**
1. User sends SOQ to the vault address with memo containing Solana pubkey
2. Relayer detects lock event via Soqucoin RPC
3. Relayer constructs `mint_from_deposit` instruction
4. 3-of-5 validators sign the mint authorization
5. pSOQ minted to user's Solana wallet

### 4. SOQ-TEC Terminal (Web Dashboard)

Static HTML/CSS/JS dashboard with Pip-Boy CRT aesthetic.

**Data Sources:**
- Soqucoin block data: `xplorer.soqu.org/api/blocks/tip/height`
- Solana slot: Solana devnet JSON-RPC
- Bridge state: Relayer REST API

---

## Trust Model

### What You Trust

| Component | Trust Assumption |
|-----------|-----------------|
| **Soqucoin L1** | Honest majority of mining hashpower |
| **Relayer validators** | 3-of-5 honest validators |
| **Solana program** | Anchor framework + program correctness |
| **Dilithium** | NIST FIPS 204 cryptographic hardness |

### What You Don't Trust

| Component | Why |
|-----------|-----|
| **Classical Ed25519** | Broken by Shor's algorithm on CRQC |
| **Single relayer** | Threshold signature prevents unilateral action |
| **Solana for PQ custody** | That's literally why we exist |

---

## Quantum Security Comparison

| Property | Solana (Ed25519) | Winternitz Vault | SOQ-TEC Vault |
|----------|-----------------|------------------|---------------|
| **Algorithm** | Ed25519 (classical) | WOTS+ (hash-based) | ML-DSA-44 (lattice) |
| **NIST standard** | ❌ Not PQ | ❌ Not standardized | ✅ FIPS 204 |
| **Key reuse** | ✅ Unlimited | ❌ Single use | ✅ Unlimited |
| **Token support** | ✅ All SPL | ❌ SOL only | ✅ All assets |
| **DeFi composability** | ✅ Full | ❌ None | ✅ Via bridge |
| **Signature size** | 64 bytes | 896 bytes | 2,420 bytes |
| **Quantum resistant** | ❌ | ✅ (limited) | ✅ (full NIST) |

---

## Network Endpoints

| Service | URL | Purpose |
|---------|-----|---------|
| SOQ-TEC Terminal | `soqtec.soqu.org` | Bridge dashboard |
| Soqucoin Explorer | `xplorer.soqu.org` | Block explorer |
| Soqucoin RPC | `rpc.soqu.org` | Node JSON-RPC |
| Solana (devnet) | `api.devnet.solana.com` | Solana devnet RPC |

---

## Future: LatticeFold+ L2

Soqucoin's Layer 2 (LatticeFold+ recursive verification) is on the roadmap to bring high-throughput PQ transactions to the ecosystem. When shipped, this makes the bridge even more compelling — users get both speed AND quantum safety without leaving the Soqucoin ecosystem.

But for the hackathon, the honest pitch is: **security for storage, speed when you bridge back to Solana.**
