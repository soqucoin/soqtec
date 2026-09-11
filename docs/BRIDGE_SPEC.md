# SOQ-TEC Bridge Protocol Specification

> This specification describes the protocol the software implements. "The bridge", "the relayer", "the
> vault", "admin" and "protocol treasury" name software roles and components. They are not services that
> Soqucoin Labs operates. The fee schedule in section 10 is a configurable parameter of the software; Labs
> charges no transfer fee and operates no bridge. The token mapping and the proof-of-reserves design were
> exercised with test tokens on test networks only. The pSOQ to SOQ path is in legal review.

> Version 1.0.0 — Colosseum Frontier Hackathon 2026

---

## 1. Overview

The SOQ-TEC Bridge software moves assets in both directions between Solana and Soqucoin L1. **The entire attestation chain is quantum-secure** — relayer validators sign with NIST FIPS 204 ML-DSA-44 (Dilithium), not Ed25519 or ECDSA.

This means an attacker with a cryptographically relevant quantum computer (CRQC) **cannot forge bridge attestations**, even if they break every Ed25519 key on Solana. The trust chain — from attestation signature to vault custody — uses only post-quantum cryptography.

### Token Mapping

The software maps one SPL token on Solana to the native coin on Soqucoin L1. pSOQ is a token on Solana. The path from pSOQ to SOQ is in legal review and details will be published when it is complete.

### Core Differentiator

Every existing bridge (Wormhole, LayerZero, Axelar) secures its attestation layer with classical signatures:

| Bridge | Attestation Signature | Quantum Status |
|--------|-----------------------|----------------|
| Wormhole | ECDSA (secp256k1) | ❌ Broken by Shor's |
| LayerZero | Ed25519 (ULN relayer) | ❌ Broken by Shor's |
| Axelar | ECDSA threshold | ❌ Broken by Shor's |
| **SOQ-TEC** | **ML-DSA-44 (Dilithium)** | **✅ NIST FIPS 204** |

While cross-chain infrastructure has historically suffered from smart contract validation bugs and custody exploits, the SOQ-TEC gateway focuses on cryptographic longevity. By utilizing Dilithium signatures, the attestation layer is mathematically secured against quantum decryption. Forging a SOQ-TEC attestation would require solving the Module-LWE (Learning with Errors) problem, which is designed to resist quantum computing attacks that threaten classical ECDSA and Ed25519 signatures.

---

## 2. Bridge Flow: Solana → Soqucoin (Redemption)

**Purpose**: A user of a licensed operator's deployment moves value from Solana to that operator's vault on Soqucoin L1.

```
User                    Solana Program           Relayer Network          Soqucoin L1
  │                          │                        │                       │
  │──burn_for_redemption()──►│                        │                       │
  │   amount: 1000 pSOQ      │                        │                       │
  │   soq_addr: <dilithium>  │                        │                       │
  │                          │                        │                       │
  │                          │──emit BurnEvent───────►│                       │
  │                          │  (tx_sig, amount, addr) │                       │
  │                          │                        │                       │
  │                          │      ┌─────────────────┤                       │
  │                          │      │ Each validator:  │                       │
  │                          │      │ 1. Verify burn   │                       │
  │                          │      │ 2. Sign with     │                       │
  │                          │      │    DILITHIUM     │                       │
  │                          │      │ 3. Broadcast     │                       │
  │                          │      │    attestation   │                       │
  │                          │      └─────────────────┤                       │
  │                          │                        │                       │
  │                          │      3-of-5 Dilithium  │                       │
  │                          │      attestations      │                       │
  │                          │      collected         │                       │
  │                          │                        │                       │
  │                          │                        │──construct_release()──►│
  │                          │                        │  3-of-5 Dilithium sigs │
  │                          │                        │                       │
  │                          │                        │           ┌────────────┤
  │                          │                        │           │ 240 blocks │
  │                          │                        │           │ maturity   │
  │                          │                        │           └────────────┤
  │                          │                        │                       │
  │                          │                        │◄──release_confirmed───│
  │                          │                        │                       │
  │◄─────────────────────────────────notification─────────────────────────────│
  │   "1000 SOQ available at <dilithium_addr>"                                │
```

> *Flow diagram current as of v1.0.0. Updated to reflect PAUL optimistic release (Solana→SOQ) is in progress.*

### Steps

1. **User** calls `burn_for_redemption(amount, soq_address)` on the Solana bridge program
2. **Solana program** burns `amount` pSOQ from user's token account, emits `BurnEvent`
3. **Each relayer validator** independently detects and verifies the burn transaction
4. **Each validator signs an attestation with their Dilithium key** (not Ed25519)
5. **Attestation aggregator** collects 3-of-5 Dilithium signatures
6. **Release transaction** constructed for Soqucoin L1 with 3-of-5 Dilithium multisig
7. **Release**: Release follows burn confirmation and attestation. The demonstration build released on detection without pre-release verification; that mode is not suitable for production and is not part of the specification.

### Validation Rules (Per Validator)

- Burn transaction must be finalized on Solana (confirmed status)
- Amount must be ≥ 10 SOQ (minimum transfer; configurable via `MIN_TRANSFER` env var)
- `soq_address` must be a valid Soqucoin bech32m address
- No duplicate burn_tx_sig in processed history (replay protection)
- Bridge must not be paused
- Backing ratio must remain ≥ 0.95 after release

---

## 3. Bridge Flow: Soqucoin → Solana (Deposit)

**Purpose**: A user of a licensed operator's deployment moves value from Soqucoin back to Solana.

```
User                    Soqucoin L1              Relayer Network          Solana Program
  │                          │                        │                       │
  │──send_to_vault()────────►│                        │                       │
  │   amount: 1000 SOQ       │                        │                       │
  │   memo: <solana_pubkey>  │                        │                       │
  │                          │                        │                       │
  │                          │──240 block maturity────│                       │
  │                          │                        │                       │
  │                          │      ┌─────────────────┤                       │
  │                          │      │ Each validator:  │                       │
  │                          │      │ 1. Confirm lock  │                       │
  │                          │      │ 2. Sign with     │                       │
  │                          │      │    DILITHIUM     │                       │
  │                          │      │ 3. Hash into     │                       │
  │                          │      │    Merkle tree   │                       │
  │                          │      └─────────────────┤                       │
  │                          │                        │                       │
  │                          │                        │──mint_from_deposit()──►│
  │                          │                        │  Merkle root + proof   │
  │                          │                        │                       │
  │                          │                        │◄──mint_confirmed──────│
  │                          │                        │                       │
  │◄─────────────────────────────────notification─────────────────────────────│
  │   "1000 pSOQ minted to <solana_pubkey>"                                   │
```

> *Flow diagram current as of v1.0.0. Updated diagram reflecting confirmed E2E deposit flow is in progress.*

### Steps

1. **User** sends SOQ to the vault address with memo containing their Solana public key
2. **Soqucoin L1** confirms the transaction; relayer waits for 240-block maturity
3. **Each validator** independently confirms the lock and signs an attestation with Dilithium
4. **Attestation Merkle tree** constructed from all validator signatures (see Section 5)
5. **Solana program** verifies the Merkle root and proof (hash-based — quantum-safe)
6. **The operator's program mints** the Solana-side token to the user's Solana wallet

### Validation Rules (Per Validator)

- Lock transaction must have 240+ confirmations (SOQ → Solana only; provides finality before minting pSOQ)
- Amount must be ≥ 10 SOQ (minimum transfer; configurable via `MIN_TRANSFER` env var)
- Memo must contain a valid Solana public key (32 bytes, base58)
- Vault balance must cover the lock (sanity check)
- No duplicate lock_txid in processed history

---

## 4. Dilithium Attestation Protocol

This is the core security design of SOQ-TEC. Every bridge attestation is signed with ML-DSA-44 (Dilithium).

### 4.1 Validator Key Architecture

Each of the 5 relayer validators holds two keypairs:

```
Validator Node
├── ML-DSA-44 Keypair (PRIMARY — all attestations)
│   ├── Public key:  1,312 bytes (FIPS 204)
│   └── Secret key:  2,560 bytes (FIPS 204)
│
└── Ed25519 Keypair (Solana transaction signing ONLY)
    ├── Public key:  32 bytes
    └── Secret key:  64 bytes
```

**Critical distinction:** The Ed25519 key is used ONLY for submitting transactions to Solana (because Solana requires Ed25519 for transaction signatures). It is NOT used for attestation signing. If an attacker breaks a validator's Ed25519 key, they can submit garbage transactions to Solana, but they **cannot forge attestations** — those require the Dilithium key.

### 4.2 Attestation Message Format

```json
{
  "version": "soqtec-attestation-v1",
  "type": "burn_verified" | "lock_verified",
  "source": {
    "chain": "solana" | "soqucoin",
    "tx_reference": "<tx_sig or txid>",
    "block_reference": "<slot or block_height>",
    "amount": 1000000000,
    "destination": "<recipient address on target chain>"
  },
  "validator": {
    "id": 1,
    "dilithium_pubkey": "<base64 ML-DSA-44 public key>"
  },
  "timestamp": 1744041600,
  "nonce": "<random 32-byte hex>",
  "signature": "<base64 ML-DSA-44 signature over canonical JSON>"
}
```

### 4.3 Signature Construction

```
attestation_payload = canonical_json_serialize({
    version, type, source, validator.id, timestamp, nonce
})

signature = ML_DSA_44_Sign(validator_secret_key, SHA3-256(attestation_payload))
```

- **Hash**: SHA3-256 (FIPS 202) — quantum-resistant against Grover's with 128-bit security
- **Signature**: ML-DSA-44 (FIPS 204) — quantum-resistant against Shor's (NIST Security Level 2)
- **Nonce**: Random 32-byte value prevents replay across attestation rounds

### 4.4 Threshold Collection

The attestation aggregator (leader node, rotates per round) collects attestations:

1. Wait for attestations from at least 3 of 5 validators
2. Verify each attestation's Dilithium signature against the validator's known public key
3. Verify all attestations reference the same source transaction and amount
4. Construct the aggregated attestation (see Section 5 for Merkle commitment)

**Liveness**: If fewer than 3 validators respond within the timeout (60 seconds), the round is retried. After 3 failed rounds, the bridge auto-pauses.

**Equivocation detection**: If a validator signs conflicting attestations for the same round (different amounts or destinations), the validator is flagged and excluded from future rounds until manual review.

---

## 5. Merkle Commitment Scheme (Solana Verification)

Solana does not support Dilithium signature verification on-chain. To bridge this gap without compromising quantum security, SOQ-TEC uses a **Merkle commitment scheme** where Solana verifies hash-based proofs (quantum-safe) rather than classical signatures.

### 5.1 Why Not Just Use Ed25519 Multisig on Solana?

Using Ed25519 multisig for Solana-side verification creates a single point of quantum failure. If an attacker compromises the Ed25519 keys (via quantum attack), they can authorize arbitrary mints — draining the bridge.

The Merkle commitment scheme eliminates this by ensuring Solana only verifies hash operations (SHA-256), which are quantum-resistant with ≥128-bit security against Grover's algorithm.

### 5.2 Commitment Construction

```
For each validator attestation:
    leaf[i] = SHA-256(attestation[i].signature || attestation[i].validator_pubkey)

Merkle tree:
    Layer 0 (leaves): [leaf[0], leaf[1], leaf[2], leaf[3], leaf[4]]
    Layer 1:          [H(leaf[0]||leaf[1]), H(leaf[2]||leaf[3]), leaf[4]]
    Layer 2:          [H(L1[0]||L1[1]), leaf[4]]
    Root:             H(L2[0]||L2[1])
```

### 5.3 On-Chain Verification (Solana Program)

The Solana bridge program stores registered commitment roots:

```rust
#[account]
pub struct AttestationRegistry {
    /// Merkle roots from validator committee, pre-registered
    pub registered_roots: Vec<[u8; 32]>,
    /// Processed transaction map (replay protection)
    pub processed_txs: Vec<[u8; 32]>,
    /// Current epoch  
    pub epoch: u64,
}
```

**Verification flow:**

1. Relayer submits: `(mint_instruction, merkle_root, merkle_proof[])`
2. Solana program verifies `merkle_root` is in `registered_roots`
3. Solana program verifies `merkle_proof` hashes to `merkle_root`
4. If valid: execute mint instruction

**Root registration:** Validator committee periodically registers new Merkle roots (signed by 3-of-5 Dilithium attestations, reduced to root via offline verification). This is the only step that uses Ed25519 on Solana — and it's a one-time registration, not per-transfer, minimizing the quantum attack window.

### 5.4 Security Properties

| Attack | Mitigation |
|--------|------------|
| Forge attestation signature | Requires breaking ML-DSA-44 (Module-LWE hardness) |
| Forge Merkle proof | Requires SHA-256 preimage (≥128-bit quantum security) |
| Replay attestation | Nonce + processed_txs deduplication |
| Compromise Ed25519 root registration key | Root registration is infrequent; key rotation every epoch; committee can revoke |
| Compromise single validator | 3-of-5 threshold — attacker needs 3 Dilithium keys |

---

## 6. Proof of Reserves

The software publishes a proof-of-reserves attestation for the operator's vault. Backing is the operator's obligation.

```
Backing Ratio = SOQ_locked_in_vault / pSOQ_total_supply
```

**Target**: 1.00, maintained by the operator

**On-chain attestation** (Solana):
- `vault_balance` field in `BridgeState` account
- Updated by relayer consensus (3-of-5 Dilithium attestations → Merkle root → Solana verification)
- Publicly queryable — anyone can verify backing ratio

**Soqucoin verification**:
- The operator publishes the vault address
- Balance verifiable via `getbalance` RPC or block explorer
- UTXO-based — every input and output is auditable

**On-chain attestation** (Soqucoin L1):
- Periodic `OP_RETURN` attestation transaction signed with vault Dilithium key
- Contains: `SOQ-TEC-PoR | <timestamp> | <vault_balance> | <pSOQ_supply> | <ratio>`
- Permanently recorded in Soqucoin blockchain — tamper-proof audit trail

---

## 7. Circuit Breaker

### Trigger Conditions

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Volume per epoch | > 10% of vault balance | Pause bridge |
| Backing ratio | < 0.95 | Pause bridge |
| Validator liveness | < 3 of 5 responding | Pause bridge |
| Attestation conflict | Any equivocation detected | Pause + flag validator |
| Manual trigger | Operator 2-of-3 multisig | Pause bridge |

### Recovery

1. The operator investigates the trigger condition
2. If legitimate: `resume_bridge()` with the operator's 2-of-3 multisig (Dilithium on Soqucoin side)
3. If attack: keep paused, revoke compromised validator keys, begin incident response

---

## 8. Message Formats

### BurnEvent (Solana → Relayer)

```json
{
  "event": "burn_for_redemption",
  "tx_signature": "5XkR...base58",
  "amount": 1000000000,
  "soq_address": "SQq1abc...base58check",
  "timestamp": 1744041600,
  "slot": 312000000
}
```

### LockEvent (Soqucoin → Relayer)

```json
{
  "event": "vault_lock",
  "txid": "a1b2c3d4...hex",
  "amount": 1000000000,
  "solana_pubkey": "7nYk...base58",
  "block_height": 2500,
  "confirmations": 240
}
```

### ValidatorAttestation (Dilithium-signed)

```json
{
  "version": "soqtec-attestation-v1",
  "type": "burn_verified",
  "source": {
    "chain": "solana",
    "tx_reference": "5XkR...base58",
    "block_reference": 312000000,
    "amount": 1000000000,
    "destination": "SQq1abc...base58check"
  },
  "validator": {
    "id": 3,
    "dilithium_pubkey": "base64..."
  },
  "timestamp": 1744041600,
  "nonce": "a1b2c3d4e5f6...hex32",
  "signature": "base64...(2420 bytes ML-DSA-44)"
}
```

### AggregatedAttestation (submitted to chain)

```json
{
  "version": "soqtec-aggregated-v1",
  "type": "release" | "mint",
  "source_tx": "<source chain tx reference>",
  "amount": 1000000000,
  "destination": "<recipient address>",
  "merkle_root": "<32-byte hex SHA-256>",
  "attestations": [
    { "validator": 1, "dilithium_sig": "base64..." },
    { "validator": 3, "dilithium_sig": "base64..." },
    { "validator": 5, "dilithium_sig": "base64..." }
  ],
  "merkle_proof": ["<32-byte hex>", "<32-byte hex>", "..."],
  "timestamp": 1744041600
}
```

---

## 9. Quantum Security Analysis

### End-to-End Attestation Chain

```
Event Detection     →  Attestation Signing  →  Verification        →  Execution
(chain watcher)        (DILITHIUM ML-DSA-44)   (Merkle/SHA-256)       (chain-native)
                       ✅ PQ-SAFE              ✅ PQ-SAFE             ✅ PQ-SAFE (SOQ)
                                                                       ⚠ Ed25519 (SOL tx)
```

**Solana transaction signing is the ONLY classical crypto in the chain.** This is Solana's limitation, not ours. The bridge itself — attestation, verification, custody — is fully post-quantum.

### Attack Surface Comparison

| Attack Vector | Wormhole (ECDSA) | SOQ-TEC (Dilithium) |
|---------------|------------------|---------------------|
| **Forge guardian/validator attestation** | ❌ Shor's algorithm breaks ECDSA in polynomial time | ✅ Module-LWE: no known quantum algorithm |
| **Forge verification proof** | N/A (ECDSA on-chain verify) | ✅ SHA-256 Merkle: 128-bit quantum security (Grover's) |
| **Steal vault funds** | Bridge hack = drain vault | ✅ 3-of-5 Dilithium multisig on Soqucoin L1 |
| **Replay attack** | Nonce-based | ✅ Nonce + processed_txs + Merkle root epoch rotation |
| **Single validator compromise** | 13-of-19 threshold | ✅ 3-of-5 threshold (same trust model, PQ keys) |

### NIST Compliance

| Component | Standard | Security Level |
|-----------|----------|----------------|
| Attestation signatures | FIPS 204 (ML-DSA-44) | NIST Level 2 (128-bit quantum) |
| Merkle hashing | FIPS 180-4 (SHA-256) | 128-bit quantum (Grover) |
| Attestation payload hash | FIPS 202 (SHA3-256) | 128-bit quantum (Grover) |
| Vault custody | FIPS 204 (ML-DSA-44) | NIST Level 2 |
| Soqucoin addresses | BLAKE2b-160 | Quantum-resistant |

---

## 10. Fee Parameters

Fees are a deployment parameter set by the operator. The software supports a percentage fee with a minimum transfer amount and a configurable split between relayer validators and an operator-defined account. Fees, when configured, are deducted from the transfer amount. Proof-of-reserves attestation updates carry no fee. Soqucoin Labs charges no fee and receives no fee.

---

## 11. XMSS-Lite Revolving Vault (Quantum-Safe SPL Custody)

> **Full design specification:** `soqucoin-ops/design-log/DL-SOQTEC-REVOLVING-VAULT.md`
> **Patent:** Filed — Provisional #64/035,857 (XMSS-Lite Revolving Vault)
> **Status:** Anchor program implemented (`programs/xmss-vault/`); proven on Solana devnet

### Problem

The original Winternitz vault (SIMD-0075) has two critical limitations for bridge integration:
single-use keys (every withdrawal burns the keypair) and SOL-only support (no SPL tokens).
This creates a quantum-exposed gap where returning bridge tokens must land in an Ed25519
wallet between vault cycles.

### Solution: Three Novel Mechanisms

1. **XMSS-Lite** — Merkle tree of WOTS+ keypairs gives 1,024+ signatures per vault (vs. 1).
   On-chain leaf index prevents key reuse. Based on RFC 8391 / NIST SP 800-208.

2. **Direct-Mint-to-Vault** — Returning bridge tokens (pSOQ) are minted directly into the
   user's active XMSS vault ATA. Value never touches an Ed25519 wallet.

3. **Atomic Vault Rotation** — When a vault exhausts its key tree, the bridge program
   atomically closes the old vault and opens a new one in a single transaction.

### End-to-End PQ Chain

```
pSOQ in XMSS vault (WOTS+ PQ) → bridge burn → Dilithium attestation (PQ)
    → SOQ in L1 vault (ML-DSA-44 PQ) → bridge back → mint into XMSS vault (PQ)

Ed25519 touches the VALUE: never.
```

### Compute Feasibility

| Operation | Compute Units |
|-----------|---------------|
| WOTS+ signature verification | ~200,000 |
| Merkle path (10-level tree) | ~40,000 |
| SPL token transfer CPI | ~20,000 |
| Bridge burn CPI | ~30,000 |
| **Total** | **~300,000 (21% of 1.4M limit)** |

### Comparison

| Property | Original Winternitz | SOQ-TEC Revolving Vault |
|----------|--------------------|-----------------------|
| Asset support | SOL only | Any SPL token |
| Signatures per vault | 1 | 1,024+ |
| Quantum-exposed gap | Yes | None |
| Bridge integration | None | Native CPI |
| Key reuse safety | User responsibility | On-chain enforcement |

---

## 12. Upgrade Path

### Hackathon (v1.0, April to May 2026, test networks)
- Custom 3-of-5 relayer with Dilithium attestation
- Solana devnet test deployment
- SOQ-TEC Terminal demonstration dashboard with a proof-of-reserves panel
- Merkle commitment scheme for Solana-side verification

### Planned software capabilities
- XMSS-Lite Revolving Vault program (Patent #64/035,857 filed)
- Solana mainnet program support
- Permissionless validator onboarding (stake + Dilithium key registration)
- Dilithium BPF verifier on Solana (eliminates Merkle root pre-registration)
- Multi-asset vaults (any SPL token via XMSS-Lite)
- L2 fast-path for bridge settlements
- External audit of the bridge program and relayer
- Client SDK for XMSS key tree generation and vault management

Deployment on any mainnet is a decision for a licensed operator.
