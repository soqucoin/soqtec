# Quantum Hygiene Sweep: Design Spec

Status: prototype validated on testnet4, design phase for productization
Owner: Soqucoin Labs / SoquShield
Scope: read-only analysis plus on-device PSBT sweep. No hosted keys, no bridge required.

## Problem

A Bitcoin public key can be broken by a quantum computer running Shor's algorithm, but only after the key is visible on chain. Most Bitcoin holders assume their coins are safe because they use modern addresses. That assumption is wrong for anyone who reuses an address, and it is wrong for every Taproot holder.

Miners are the worst real case. Pool payouts land on one address for months or years. The first spend from that address publishes the public key, and from that point every coin sitting there, plus every future payout to it, is quantum-exposed. A single reused payout address can hold hundreds of exposed UTXOs. The prototype confirmed this against a live testnet4 address holding 163 exposed one-million-sat payout outputs behind a single revealed key.

This tool finds those coins and plans a move into storage where the key is hidden again.

## Exposure classification rules

These rules are the correctness core of the feature. They must be implemented exactly.

### EXPOSED (public key is on chain and attackable now)

- P2PK outputs. The raw public key sits directly in the output script.
- All Taproot outputs (P2TR, addresses starting `bc1p`, `tb1p`, `bcrt1p`). The 32-byte x-only public key is the witness program itself. It is on chain the moment the output is created, whether or not it has ever been spent.
- Any address that has ever been spent from. The spend reveals the public key in the scriptSig or witness, and that revelation is permanent. Address reuse is the trap: if an address has spent even once, every current UTXO and every future deposit to that address is exposed.

### LATENT (public key is still hidden behind a hash)

- P2PKH, P2WPKH, P2WSH, and P2SH addresses that have received funds but have never been spent from. The output commits only to a HASH160 or SHA256 of the key or script. The key stays secret until the first spend.

### Decision procedure per UTXO

1. If the address is Taproot, mark EXPOSED (taproot reason). Stop.
2. Else if the address has any spent history (`spent_txo_count > 0`), mark EXPOSED (reuse reason). Stop.
3. Else if the address is a known hash type (P2PKH, P2WPKH, P2WSH, P2SH), mark LATENT.
4. Else mark EXPOSED and label it conservative-unknown, so an unrecognized format is never silently called safe.

Note on ordering: Taproot is checked before spent-history because a Taproot output is exposed on creation, so the "never spent" state does not save it. For every non-Taproot type, spent history is the deciding factor.

## Prototype

File: `quantum_hygiene_sweep.py` (this directory).

Python 3, standard library plus `requests` with a `urllib` fallback so it runs on a bare interpreter. It reads the public mempool.space API and nothing else. It never sees a private key and never builds or broadcasts a transaction.

What it does:

- Takes a list of addresses on the command line or via `--addr-file`.
- Picks the chain with `--network testnet4|mainnet` (default testnet4).
- For each address, reads `GET /address/{addr}` for the spent count and `GET /address/{addr}/utxo` for the outputs.
- Classifies each UTXO with the rules above and a plain-English reason.
- Prints totals (exposed vs latent, value and count), a per-UTXO table, and a sweep plan with a fee estimate at a configurable `--sat-vb`.
- Offers `--json` for machine consumption.

The sweep plan consolidates every exposed UTXO into one or more fresh P2WPKH destinations, estimates the virtual size from per-input-type vbyte costs, and shows the exposure profile after the sweep (zero exposed, everything resting behind fresh hashes).

Validated live on testnet4 addresses including a Taproot output (exposed on creation), a heavily reused P2WPKH payout address (163 exposed UTXOs behind one revealed key), and a never-spent P2WSH output (latent).

## Productizing in SoquShield

SoquShield is a Flutter/Dart mobile wallet. The sweep fits as a self-custodial feature that never asks for a seed it does not already hold, and works equally well as a watch-only scanner.

### Import

Two supported inputs:

- A watch-only xpub or account-level extended public key.
- An output descriptor (for example `wpkh([fingerprint/84h/0h/0h]xpub.../0/*)`), which is the precise, unambiguous form and the one power users and miners already have from their mining setup.

From the descriptor or xpub, derive the receive and change address ranges with a gap-limit scan, then classify each derived address's UTXOs. Watch-only import means a user can see their exposure before deciding to trust the app with anything signable.

### Scan

Walk the derived addresses, batch the mempool.space (or a self-hosted Electrum/Esplora) lookups, and classify. Cache results so a re-scan is cheap. Show progress, because a miner's descriptor can expand to thousands of used addresses.

### Exposure dashboard

The main screen answers one question: how much of my Bitcoin is quantum-exposed, and why.

- A single headline number: BTC exposed and its percentage of the total.
- A split bar: exposed vs latent by value.
- A grouped list of exposed UTXOs with the reason per group (taproot, reused address, P2PK). Reused-address groups are the loud ones for miners and should surface the address and its UTXO count.
- A "latent and safe" section so the user sees what already needs no action.

### One-tap sweep

- The app builds a PSBT that spends the selected exposed UTXOs into fresh P2WPKH change addresses derived from the same wallet (new indexes, never used).
- The user reviews inputs, destination, fee, and the resulting exposure profile.
- The user signs on device. The private key never leaves the phone. There is no hosted signer and no server-side key custody.
- The app can hand the signed transaction to the user's own node or a public broadcast endpoint, or export it for an air-gapped signer.

Fee handling should default to a calm-mempool rate and warn if the current mempool is congested, because the sweep spend is the one moment the key is public and a fast confirmation shortens that moment.

## Honest framing

This matters for a Bitcoin audience that has heard too many quantum sales pitches.

- Fully self-custodial. The tool reads public chain data. Signing happens on the user's device with the user's keys. There is no bridge and no wrapped asset involved in the sweep itself.
- Real protection on mainnet today. Moving coins from an exposed key to a fresh hash-locked address is a plain Bitcoin transaction. It needs no soft fork and no new opcode. It works right now.
- The one caveat, stated plainly: the sweep spends the exposed UTXO, and the spend itself reveals the key in the witness at broadcast. So the sweep does not make an already-exposed coin retroactively secret. It converts permanent exposure, a naked key sitting on chain indefinitely, into one short controlled exposure window, after which the coin rests latent at a fresh address whose key has never been shown.

How to minimize that window:

- Sweep during a calm mempool so the transaction confirms quickly.
- Do it before a quantum threat is imminent, not during the panic when everyone is trying to spend at once and fees and confirmation times spike.
- Batch where it makes sense, but do not over-consolidate into a single output you will immediately reuse.
- Never reuse the destination address. A reused destination re-exposes on its own first spend.

What this tool does not claim: it does not make Bitcoin post-quantum. Bitcoin's signature scheme is still ECDSA/Schnorr. This buys time by keeping keys hidden behind hashes until they are needed, which is the best defense available on Bitcoin as it exists today.

## Relationship to the BTCSOQ boundary

The Quantum Hygiene Sweep is the honest on-ramp. It is the "not your keys, not interested" story that a Bitcoin audience respects, because it asks for nothing except a watch-only key and gives back a real, native Bitcoin action.

The two steps are separate and should be presented that way:

1. Get your coins latent first. Use this tool. Stay entirely on Bitcoin, entirely self-custodial. This is a complete action on its own and many users will stop here, which is fine.
2. Cross the boundary into BTCSOQ only if you additionally want post-quantum ownership of the claim, meaning a claim secured by a quantum-resistant signature scheme (ML-DSA) rather than by a still-classical key hidden behind a hash.

Step 1 protects the coin by hiding the key. Step 2 protects the ownership itself with post-quantum signatures. Leading with step 1 earns the trust needed to have the step 2 conversation, and it never pressures a Bitcoiner to leave Bitcoin to get value from the tool.

## Known limitations and edge cases

- P2WPKH vs P2WSH is distinguished by address length as a heuristic. This does not change the exposed/latent verdict (both are latent when never spent) but it slightly affects the sweep vbyte estimate. A production version should read the actual `scriptpubkey` from the UTXO or address endpoint.
- P2SH is ambiguous. A P2SH address can wrap a segwit key, a multisig script, or arbitrary logic. The exposure verdict is still correct (latent until first spend, exposed after), but the fee estimate treats it as a single-key input.
- Bare P2PK outputs do not have a normal address form, so an address-list tool will not encounter them directly. A UTXO-level or descriptor-level scanner should classify P2PK scripts as exposed by script pattern.
- Mempool state is included in the spent-count check, so an unconfirmed spend already flips an address to exposed, which is the correct and conservative call.
- The prototype uses a public API and can be rate limited. A production build should support a self-hosted Esplora or Electrum backend for privacy and reliability, since querying every address of a wallet against a third party leaks the wallet's composition.
