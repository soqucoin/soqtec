# SOQ-TEC Architecture

> **SOQ-TEC** — Soqucoin Operations for Quantum-Tolerant Ecosystem Custody

---

## Overview

SOQ-TEC is a bidirectional cross-chain bridge connecting Solana (classical Ed25519) to Soqucoin L1 (NIST FIPS 204 ML-DSA-44 Dilithium). It provides quantum-safe custody for Solana-native assets by enabling users to bridge value into a post-quantum L1 for long-term storage, and bridge back when speed and liquidity are needed.

**Core innovation:** SOQ-TEC is the first cross-chain bridge with a **fully post-quantum attestation layer**. Relayer validators sign attestations with ML-DSA-44 (Dilithium), not Ed25519 or ECDSA. No attacker — classical or quantum — can forge bridge attestations without breaking NIST FIPS 204.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SOQ-TEC BRIDGE                             │
│                                                                     │
│  ┌──────────────────────┐         ┌──────────────────────────────┐  │
│  │    SOLANA SIDE        │         │    SOQUCOIN SIDE              │  │
│  │    (Ed25519 txns)     │         │    (100% PQ-native)           │  │
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
│  │  │ Merkle verify  │◄─── PQ ───│  │ 240-block maturity     │  │  │
│  │  └───────┬────────┘  │         │  └───────────┬────────────┘  │  │
│  │          │            │         │              │               │  │
│  └──────────┼────────────┘         └──────────────┼───────────────┘  │
│             │                                     │                  │
│             ▼                                     ▼                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │              SOQ-TEC RELAYER ATTESTATION ENGINE                 │  │
│  │                                                                │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐ ┌──────┐ │  │
│  │  │   V1     │  │   V2     │  │   V3     │  │  V4  │ │  V5  │ │  │
│  │  │ ML-DSA-44│  │ ML-DSA-44│  │ ML-DSA-44│  │ML-DSA│ │ML-DSA│ │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──┬───┘ └──┬───┘ │  │
│  │       │              │              │            │        │     │  │
│  │       └──────────────┴──────┬───────┴────────────┴────────┘     │  │
│  │                             │                                   │  │
│  │                    3-of-5 Dilithium Threshold                  │  │
│  │                             │                                   │  │
│  │                    ┌────────▼────────┐                          │  │
│  │                    │ Merkle Commit   │                          │  │
│  │                    │ SHA-256 root    │ ◄── PQ-safe hash         │  │
│  │                    └────────┬────────┘                          │  │
│  │                             │                                   │  │
│  │           ┌─────────────────┴─────────────────┐                │  │
│  │           ▼                                   ▼                │  │
│  │    Solana: verify Merkle proof       Soqucoin: verify          │  │
│  │    (hash-based = PQ-safe)            Dilithium sigs directly   │  │
│  │                                      (PQ-native)               │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                   SOQ-TEC TERMINAL (Web)                       │  │
│  │   Dashboard — vault balance, bridge activity, PoR, security   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

> *Diagram current as of v1.0.0. Updates to reflect PAUL optimistic release architecture and confirmed E2E flows are in progress.*

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

#[account]
pub struct AttestationRegistry {
    pub registered_roots: Vec<[u8; 32]>,  // Merkle roots from validator committee
    pub processed_txs: Vec<[u8; 32]>,     // Replay protection
    pub epoch: u64,                        // Current attestation epoch
}
```

**Instructions:**

| Instruction | Direction | Description |
|-------------|-----------|-------------|
| `burn_for_redemption` | SOL → SOQ | Burns pSOQ, emits event for relayer |
| `mint_from_deposit` | SOQ → SOL | Mints pSOQ after Merkle proof verification |
| `update_vault_balance` | — | Updates on-chain PoR from Merkle-committed attestation |
| `register_merkle_root` | — | Registers new attestation Merkle root (epoch rotation) |
| `pause_bridge` / `resume_bridge` | — | Emergency circuit breaker (admin only) |

**Safety Features:**
- Volume-based circuit breaker (max per-epoch)
- Minimum transfer amount (100 SOQ)
- Pause authority for emergency response
- On-chain Proof of Reserves attestation
- Merkle proof verification (hash-based, quantum-safe)

### 2. SSH Relayer Attestation Engine (TypeScript/Node)

The off-chain service that watches both chains and coordinates quantum-secure attestations.

**Validator Key Architecture:**

Each validator holds two keypairs:
- **ML-DSA-44 (Dilithium)** — used for ALL attestation signing. This is the trust anchor.
- **Ed25519** — used ONLY for submitting raw transactions to Solana (Solana's requirement). NOT used for attestation.

**Attestation Flow:**

1. Event detected on source chain (burn or lock)
2. Each validator independently verifies the event
3. Each validator signs an attestation with their **Dilithium key**
4. Attestations are broadcast to the validator gossip network
5. Leader node (rotates per round) collects 3-of-5 Dilithium attestations
6. Attestations are hashed into a **Merkle tree** (SHA-256)
7. Merkle root is submitted to the target chain for verification

**Why Dilithium, not Ed25519?**

The attestation signature is the *trust anchor* of the bridge. If an attacker can forge an attestation, they can mint arbitrary pSOQ or release arbitrary SOQ — draining the bridge. This is exactly how Wormhole was hacked for $320M (forged ECDSA guardian signature). With Dilithium attestations, forging requires breaking Module-LWE, which is quantum-resistant.

### 3. Soqucoin Vault (C++)

A 3-of-5 Dilithium multisig custody address on Soqucoin L1.

```
# P2SH-style multisig with Dilithium
OP_3 <pubkey1> <pubkey2> <pubkey3> <pubkey4> <pubkey5> OP_5 OP_CHECKMULTISIG
```

**Properties:**
- All vault operations require 3-of-5 Dilithium validator signatures
- Dilithium keys are **reusable** (unlike Winternitz one-time keys)
- 240-block maturity requirement before release (replay protection)
- UTXO-based — deterministic, auditable state

### 4. SOQ-TEC Terminal (Web Dashboard)

Static HTML/CSS/JS dashboard with Pip-Boy CRT aesthetic.

**Data Sources:**
- Soqucoin block data: `xplorer.soqu.org/api/blocks/tip/height`
- Solana slot: Solana devnet JSON-RPC
- Bridge state: Relayer REST API (`/api/status`, `/api/activity`)
- Proof of Reserves: On-chain attestation from both chains

---

## Trust Model

### What You Trust

| Component | Trust Assumption | Crypto Basis |
|-----------|-----------------|--------------|
| **Relayer attestations** | 3-of-5 honest validators | ML-DSA-44 (FIPS 204) |
| **Merkle verification** | SHA-256 collision resistance | FIPS 180-4 |
| **Soqucoin L1** | Honest majority hashpower | Scrypt PoW + ML-DSA-44 |
| **Solana program** | Anchor framework correctness | Rust type safety |

### What You Don't Trust

| Component | Why |
|-----------|-----|
| **Classical Ed25519** | Broken by Shor's algorithm on CRQC |
| **Single relayer** | 3-of-5 threshold prevents unilateral action |
| **Solana for PQ custody** | That's literally why SOQ-TEC exists |
| **Existing bridges** | ECDSA/Ed25519 attestations are quantum-vulnerable |

---

## Quantum Security: End-to-End Chain

```
┌──────────┐   ┌──────────────────┐   ┌──────────────┐   ┌────────────┐
│  Event   │──►│  Attestation     │──►│ Verification │──►│ Execution  │
│ Detected │   │  DILITHIUM SIGN  │   │ MERKLE/SHA   │   │ Chain TXN  │
│          │   │  ✅ PQ-SAFE      │   │ ✅ PQ-SAFE   │   │ ✅ SOQ: PQ │
│          │   │  (FIPS 204)      │   │ (FIPS 180-4) │   │ ⚠ SOL: Ed  │
└──────────┘   └──────────────────┘   └──────────────┘   └────────────┘
```

The only non-PQ component is Solana's own transaction signing (Ed25519) — which is Solana's constraint, not SOQ-TEC's. The bridge's trust chain is fully quantum-secure.

> *Diagram current as of v1.0.0. Updated E2E attestation flow diagram is in progress.*

---

## Comparison with Other Bridges

| Property | Wormhole | LayerZero | SOQ-TEC |
|----------|----------|-----------|---------|
| **Attestation signatures** | ECDSA (secp256k1) ❌ | Ed25519 (ULN) ❌ | **ML-DSA-44** ✅ |
| **On-chain verification** | ECDSA multisig ❌ | Oracle verify ❌ | **Merkle proof** ✅ |
| **Custody layer** | EOA / multisig ❌ | N/A | **Dilithium 3-of-5** ✅ |
| **NIST compliant** | No | No | **FIPS 204 + FIPS 180** ✅ |
| **Survived $320M-class attack** | No (hacked 2022) | Not tested | **Quantum-resistant by design** |

---

## Comparison with Winternitz (SIMD-0075)

SOQ-TEC does not compete with Winternitz — it complements it.

| Property | Winternitz Vault | SOQ-TEC |
|----------|-----------------|---------|
| **Algorithm** | WOTS+ (hash-based) | ML-DSA-44 (lattice-based) |
| **NIST standard** | ❌ Not standardized | ✅ FIPS 204 |
| **Key reuse** | ❌ Single use | ✅ Unlimited |
| **Scope** | SOL vault key only | Full bridge + custody |
| **Token support** | SOL only | pSOQ ↔ SOQ (all bridge assets) |
| **DeFi composable** | ❌ Withdrawal burns key | ✅ Standard Soqucoin txns |
| **Synergy** | Protects the vault key | Provides PQ-native destination |

**Together:** Winternitz vault on Solana → SOQ-TEC bridge → PQ custody on Soqucoin L1. Each layer adds security.

---

## Network Endpoints

| Service | URL | Purpose |
|---------|-----|---------|
| SOQ-TEC Terminal | `soqtec.soqu.org` | Bridge dashboard |
| Soqucoin Explorer | `xplorer.soqu.org` | Block explorer |
| Soqucoin RPC | `rpc.soqu.org` | Node JSON-RPC |
| Solana (devnet) | `api.devnet.solana.com` | Solana devnet RPC |
| Source Code | `github.com/soqucoin/soqtec` | Public repository |

---

## Future: LatticeFold+ L2

Soqucoin's Layer 2 (LatticeFold+ recursive verification) is on the roadmap to bring high-throughput PQ transactions to the ecosystem. When shipped, bridge settlements can occur on L2 with sub-second finality while maintaining full quantum security — giving users both speed AND quantum safety without leaving the Soqucoin ecosystem.

For the hackathon, the honest pitch is: **security for storage, speed when you bridge back to Solana.**
