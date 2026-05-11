# SOQ-TEC Bridge & Vault — Canonical Address Registry

> **Status:** AUTHORITATIVE — Updated 2026-05-10
> **Purpose:** Single source of truth for ALL on-chain addresses used in the SOQ-TEC bridge ecosystem.
> **Rule:** If a service uses an address not in this registry, it's WRONG. Update this file, not the service.

---

## Network: Solana Devnet

### Programs

| Program | Address | Deployed |
|---------|---------|----------|
| **XMSS Vault** | `7k4TwwBSZ4a7JA83MgSsqxczU6bpR7qV3uUNGWbTEz8H` | 2026-05-09 |
| **SOQ-TEC Bridge** | `9pCJxjVF8VTizZ9RZZLTu997y2DafWgUGqYbrNiqPw36` | 2026-05-10 (set_mint added) |

### Token Mints

| Token | Mint Address | Notes |
|-------|-------------|-------|
| **pSOQ (ACTIVE)** | `6gk5DxEkFXszk2naw9JpZa9DPy5XG9fBGBwfhhS1mMS6` | Used by SoquShield, bridge_state.mint |
| ~~pSOQ (STALE)~~ | `7TCU5SnLR7ARRAd8aUdoAFgw9zvCvzwdphm7TjUT6s46` | Old E2E test mint — DO NOT USE |

### PDAs (Deterministic)

| PDA | Seeds | Address | Program |
|-----|-------|---------|---------|
| **Bridge State** | `["bridge"]` | `9d9m1uaEBdwpLSjDhdyWZxnbTqHWbgMYDKTWybcKs2Ba` | Bridge |
| **Vault** | `["xmss-vault", merkle_root]` | *(per-vault, derived at runtime)* | Vault |
| **Vault ATA** | ATA(vault_pda, pSOQ_mint) | *(per-vault, derived at runtime)* | ATA Program |

### System Programs

| Program | Address |
|---------|---------|
| **SPL Token** | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| **Associated Token** | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| **System Program** | `11111111111111111111111111111111` |

### Deployer Wallet

| Key | Path |
|-----|------|
| **soqtec-deployer** | `~/.config/solana/soqtec-deployer.json` |
| **Public Key** | *(check with `solana address -k ~/.config/solana/soqtec-deployer.json`)* |

### RPC Endpoint

| Env | URL |
|-----|-----|
| **Devnet (Helius)** | `https://devnet.helius-rpc.com/?api-key=ea8d9de9-6ac5-429b-8225-4bc669e0c8d3` |

---

## Cross-Reference: Where Addresses Are Used

| Address | Used In | Constant Name |
|---------|---------|---------------|
| pSOQ Mint `6gk5D...` | `vault_bridge_service.dart` L43 | `bridgePsoqMint` |
| pSOQ Mint `6gk5D...` | `solana_service.dart` L14 | `psoqMint` |
| Bridge Program | `vault_bridge_service.dart` L42 | `bridgeProgramId` |
| Vault Program | `vault_bridge_service.dart` L41 | `vaultProgramId` |
| Bridge Program | `e2e-vault-bridge-test.js` L37 | `BRIDGE_PROGRAM_ID` |
| Vault Program | `e2e-vault-bridge-test.js` L36 | `VAULT_PROGRAM_ID` |
| ~~Old pSOQ Mint~~ | `e2e-vault-bridge-test.js` L38 | `PSOQ_MINT` (**NEEDS UPDATE**) |

---

## Incident Log

### 2026-05-10: Mint Mismatch (ConstraintRaw 0x7d3)

**Symptom:** `BurnForRedemption` CPI failed with `ConstraintRaw` on `user_token_account`.

**Root Cause:** Bridge initialized with mint `7TCU5...` but SoquShield vault uses mint `6gk5D...`. The constraint `user_token_account.mint == bridge_state.mint` failed.

**Fix:** Added `set_mint` admin instruction to bridge program. Called it to update `bridge_state.mint` → `6gk5D...`.

**Prevention:** This registry file. All address changes must be reflected here AND in all cross-references above.

---

> ⚠️ **IMPORTANT**: The E2E test (`e2e-vault-bridge-test.js` L38) still uses the OLD mint `7TCU5...`.
> It must be updated to `6gk5DxEkFXszk2naw9JpZa9DPy5XG9fBGBwfhhS1mMS6` before next run.
