# SOQ-TEC Security Model

> Trust assumptions, threat model, and security properties of the SOQ-TEC bridge.

---

## Threat Model

### Primary Threat: Cryptographically Relevant Quantum Computers (CRQC)

A sufficiently powerful quantum computer running **Shor's algorithm** can recover private keys from any ECDSA or EdDSA public key. This breaks:

- **Ed25519** (Solana) — every wallet, every program authority
- **secp256k1** (Bitcoin, Ethereum) — every address that has ever transacted
- **ECDH** (TLS, key exchange) — retroactive decryption of recorded traffic

**Timeline estimates** (NIST, NSA, industry consensus):
- **2030–2035**: First CRQC capable of breaking 256-bit ECC
- **Now**: Nation-state actors are performing HNDL (Harvest Now, Decrypt Later) attacks

### SOQ-TEC's Response

The bridge provides a **quantum-safe custody layer** using NIST FIPS 204 ML-DSA-44 (Dilithium), which is based on the hardness of lattice problems — specifically, Module Learning With Errors (M-LWE). No known quantum algorithm efficiently solves M-LWE.

---

## Security Properties

### 1. Vault Security (Soqucoin Side)

| Property | Implementation |
|----------|---------------|
| **Algorithm** | ML-DSA-44 (FIPS 204) — NIST Level 2 |
| **Key management** | 3-of-5 Dilithium multisig |
| **Replay protection** | 240-block maturity + nonce tracking |
| **Audit** | Halborn security audit — completed & remediated (2026) |
| **Key reuse** | Safe — Dilithium supports unlimited signatures per keypair |

### 2. Bridge Security (Cross-Chain)

| Property | Implementation |
|----------|---------------|
| **Message authentication** | Threshold signatures (3-of-5 relayer validators) |
| **Double-spend prevention** | Burn-before-release (atomic on Solana side) |
| **Volume limits** | Per-epoch circuit breaker |
| **Emergency stop** | Admin pause authority |
| **Proof of Reserves** | On-chain attestation updated by relayer consensus |

### 3. Solana Program Security (Anchor)

| Property | Implementation |
|----------|---------------|
| **PDA authority** | Mint/burn authority held by program PDA, not EOA |
| **Access control** | Admin operations require multisig threshold |
| **Upgrade authority** | Program upgrade key held in cold storage |
| **Input validation** | All amounts validated, overflow checks via Rust safe math |

---

## Trust Assumptions

### What Must Be True for Safety

1. **Lattice hardness holds** — M-LWE is not efficiently solvable (overwhelming cryptographic consensus)
2. **3-of-5 relayer honesty** — At least 3 of 5 validators are honest (byzantine fault tolerance)
3. **Soqucoin chain liveness** — Mining network continues producing blocks
4. **Solana program correctness** — No bugs in the Anchor bridge program

### What We Explicitly Don't Trust

1. **Classical Ed25519** — the entire premise of the project
2. **Any single relayer** — threshold signature prevents unilateral theft
3. **Solana for long-term custody** — that's why users bridge to Soqucoin
4. **"Quantum is far away"** — HNDL attacks make timeline irrelevant

---

## Known Limitations

### Honest Tradeoffs

| Limitation | Context | Mitigation |
|-----------|---------|------------|
| **L1 is slow** (~60s blocks) | Soqucoin is Dogecoin-derived, optimized for security not speed | Bridge back to Solana for speed; L2 (LatticeFold+) on roadmap |
| **Relayer centralization** | 3-of-5 is not fully decentralized | Planned expansion to permissionless validator set |
| **Bridge latency** | 240-block maturity = ~4 hours | Appropriate for custody transfers, not trading |
| **Devnet demo** | Hackathon demo runs on Solana devnet | Production deployment after mainnet audit |
| **Winternitz is limited** | Handles lamports only, single-use keys | We extend it, not replace it — bridge adds token support |

### Attack Vectors Considered

| Attack | Impact | Mitigation |
|--------|--------|------------|
| **Relayer collusion** (3+ malicious) | Unauthorized mint/release | Extend to 5-of-9, add timelock, on-chain PoR verification |
| **Soqucoin reorg** | Double-spend on release | 240-block maturity (4+ hours of confirmations) |
| **Solana program exploit** | Unauthorized pSOQ mint | Anchor safety checks, audited code, pause authority |
| **HNDL on bridge messages** | Future decryption of relay data | Bridge messages are public by design — no secrets in transit |
| **Quantum attack on vault** | Private key recovery | ML-DSA-44 (NIST Level 2) — quantum-safe by construction |

---

## Audit Status

| Audit | Scope | Status | Firm |
|-------|-------|--------|------|
| **Soqucoin L1** | Consensus, wallet crypto, PAT opcodes | ✅ Completed & remediated | Halborn (2026) |
| **Bridge program** | Anchor program (Solana side) | 🔨 Post-hackathon | TBD |
| **Relayer** | Off-chain validator service | 🔨 Post-hackathon | TBD |

---

## Standards Compliance

| Standard | Compliance |
|----------|-----------|
| **NIST FIPS 204** | ML-DSA-44 (Dilithium) — production implementation |
| **NIST SP 800-208** | Hash-based signatures (Winternitz reference) |
| **CNSA 2.0** | NSA Commercial National Security Algorithm Suite |
| **FIPS 140-3** | Targeted for production key management |

---

## Responsible Disclosure

Security issues should be reported to: **security@soqu.org**

Do not open public GitHub issues for security vulnerabilities.
