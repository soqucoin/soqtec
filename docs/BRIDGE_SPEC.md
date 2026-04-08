# SOQ-TEC Bridge Protocol Specification

> Version 0.1.0 — Draft (Colosseum Frontier Hackathon)

---

## 1. Overview

The SOQ-TEC Bridge enables bidirectional asset transfers between Solana and Soqucoin L1. It uses a **burn-and-mint** model on the Solana side and a **lock-and-release** model on the Soqucoin side, coordinated by a threshold-signature relayer service.

### Token Mapping

| Solana | Soqucoin | Ratio |
|--------|----------|-------|
| pSOQ (SPL token) | SOQ (native coin) | 1:1 |

---

## 2. Bridge Flow: Solana → Soqucoin (Redemption)

**Purpose**: User moves value from Solana to quantum-safe custody on Soqucoin L1.

```
User                    Solana Program           Relayer (3-of-5)         Soqucoin L1
  │                          │                        │                       │
  │──burn_for_redemption()──►│                        │                       │
  │   amount: 1000 pSOQ      │                        │                       │
  │   soq_addr: <dilithium>  │                        │                       │
  │                          │                        │                       │
  │                          │──emit BurnEvent───────►│                       │
  │                          │  (tx_sig, amount, addr) │                       │
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

### Steps

1. **User** calls `burn_for_redemption(amount, soq_address)` on the Solana bridge program
2. **Solana program** burns `amount` pSOQ from user's token account, emits `BurnEvent`
3. **Relayer** detects the event, validates the burn transaction
4. **3-of-5 validators** sign a Soqucoin release transaction
5. **Soqucoin L1** receives the multisig transaction, begins maturity countdown
6. After **240 blocks** (~4 hours), SOQ is released to the user's Dilithium address

### Validation Rules (Relayer)

- Burn transaction must be finalized on Solana (confirmed status)
- Amount must be ≥ 100 SOQ (minimum transfer)
- `soq_address` must be a valid Soqucoin P2PKH address
- No duplicate burn_tx_sig in processed history (replay protection)
- Bridge must not be paused

---

## 3. Bridge Flow: Soqucoin → Solana (Deposit)

**Purpose**: User moves value from Soqucoin back to Solana for trading/DeFi.

```
User                    Soqucoin L1              Relayer (3-of-5)         Solana Program
  │                          │                        │                       │
  │──send_to_vault()────────►│                        │                       │
  │   amount: 1000 SOQ       │                        │                       │
  │   memo: <solana_pubkey>  │                        │                       │
  │                          │                        │                       │
  │                          │──240 block maturity────│                       │
  │                          │                        │                       │
  │                          │──emit LockEvent───────►│                       │
  │                          │  (txid, amount, pubkey) │                       │
  │                          │                        │                       │
  │                          │                        │──mint_from_deposit()──►│
  │                          │                        │  3-of-5 Ed25519 sigs   │
  │                          │                        │                       │
  │                          │                        │◄──mint_confirmed──────│
  │                          │                        │                       │
  │◄─────────────────────────────────notification─────────────────────────────│
  │   "1000 pSOQ minted to <solana_pubkey>"                                   │
```

### Steps

1. **User** sends SOQ to the vault address with memo containing their Solana public key
2. **Soqucoin L1** confirms the transaction and begins maturity countdown
3. After **240 blocks**, relayer detects the confirmed lock
4. **3-of-5 validators** sign a Solana mint authorization
5. **Solana program** mints `amount` pSOQ to the user's Solana wallet
6. `update_vault_balance()` is called to update on-chain Proof of Reserves

### Validation Rules (Relayer)

- Lock transaction must have 240+ confirmations
- Amount must be ≥ 100 SOQ (minimum transfer)
- Memo must contain a valid Solana public key (32 bytes, base58)
- Vault balance must cover the lock (sanity check)
- No duplicate lock_txid in processed history

---

## 4. Proof of Reserves

The bridge maintains transparent Proof of Reserves:

```
Backing Ratio = SOQ_locked_in_vault / pSOQ_total_supply
```

**Target**: 1.00 (fully backed)

**On-chain attestation** (Solana):
- `vault_balance` field in `BridgeState` account
- Updated by relayer consensus (3-of-5 signatures required)
- Publicly queryable — anyone can verify backing ratio

**Soqucoin verification**:
- Vault address is publicly known
- Balance verifiable via `getbalance` RPC or block explorer
- UTXO-based — every input and output is auditable

---

## 5. Circuit Breaker

### Trigger Conditions

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Volume per epoch | > 10% of vault balance | Pause bridge |
| Backing ratio | < 0.95 | Pause bridge |
| Manual trigger | Admin 2-of-3 multisig | Pause bridge |

### Recovery

1. Admin investigates the trigger condition
2. If legitimate: `resume_bridge()` with 2-of-3 admin multisig
3. If attack: keep paused, begin incident response

---

## 6. Message Format

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

### RelayerAttestation

```json
{
  "type": "release" | "mint",
  "source_tx": "<source chain tx reference>",
  "amount": 1000000000,
  "destination": "<recipient address>",
  "signatures": [
    { "validator": 1, "sig": "base64..." },
    { "validator": 3, "sig": "base64..." },
    { "validator": 5, "sig": "base64..." }
  ],
  "timestamp": 1744041600
}
```

---

## 7. Fee Schedule

| Operation | Fee | Minimum |
|-----------|-----|---------|
| Solana → Soqucoin | 0.1% of amount | 100 SOQ |
| Soqucoin → Solana | 0.1% of amount | 100 SOQ |
| PoR attestation update | Free | — |

Fees are deducted from the transfer amount. Fee distribution:
- 80% to relayer validators (operational costs)
- 20% to protocol treasury (development fund)

---

## 8. Upgrade Path

### Hackathon (v0.1)
- Custom 3-of-5 relayer
- Solana devnet deployment
- SOQ-TEC Terminal dashboard

### Post-Hackathon (v0.2)
- Wormhole guardian integration (production-grade relayer)
- Solana mainnet deployment
- Permissionless validator onboarding

### Production (v1.0)
- Multi-asset support (bridged SPL tokens)
- Soqucoin mainnet vault
- LatticeFold+ L2 fast-path for bridge settlements
- Full external audit (bridge-specific)
