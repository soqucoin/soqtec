# Quantum-dark redemption: a hash-based spend on real Bitcoin Script

Status: working prototype, proven on-chain (Bitcoin Core v29.4 regtest), 2026-07-20.
Code: `ops/btcsoq/quantum-dark/` (winternitz.py, tapscript_wots.py). Bead: yp08.

## What this proves

A Bitcoin UTXO was spent, and the spend was confirmed by Bitcoin's own consensus
rules, using **only a hash-based Winternitz one-time signature**. There is no ECDSA
or Schnorr signature anywhere in the spending path, so there is nothing in it that
Shor's algorithm can break. The same signature scheme also rejects forgeries: a
witness with one element the signer could not have known is thrown out by the node.

This is the missing piece of the quantum-dark story. Mining a coinbase into a hash
address already gives a coin that exposes no key at rest (see the exposure work and
the hygiene sweep). This shows the coin can also be **moved** without exposing a key
a quantum computer could crack.

## The on-chain result (regtest)

- Valid spend txid `f6c29f5fa74db2600609060d1ba4ac9acd69664c6a0645143289a39cd5a5e737`,
  confirmed. Witness stack: 10 signature elements of 20 bytes each (the Winternitz
  chains), a 296-byte verifier script, and a 33-byte control block. No 64/65-byte
  signature. `testmempoolaccept` returned `allowed: true`.
- Forged spend (one Winternitz element replaced with `HASH160` of itself, a value
  the signer could not produce): `allowed: false`,
  reject-reason `Script failed an OP_EQUALVERIFY operation`.

## The scheme

Winternitz one-time signature (`winternitz.py`), the standard hash-chain construction
with a checksum. Security rests only on the preimage and second-preimage resistance of
the hash. Grover's algorithm gives at most a square-root speedup against a hash, so a
256-bit hash keeps about 128-bit security against a quantum attacker, and there is no
discrete-log or factoring structure for Shor to attack. The reference passes its self
test at w = 4, 16, and 256: valid signatures verify, forged and tampered ones fail.

## The Bitcoin Script realization

The verifier is a tapscript leaf (`tapscript_wots.py`). For each Winternitz chain, the
script walks the signature element the remaining number of `OP_HASH160` steps and
requires the result to equal the committed public-key element (`OP_EQUALVERIFY`). The
demo signs a 32-bit commitment at w = 16, which is 10 chains and a ~296-byte script.

Two design facts made this fit on real Bitcoin today:

1. **Tapscript has no 201-opcode limit** (BIP-342 replaced it with a sigops budget), so
   a hash-chain verifier of any practical size fits in one leaf. This is the same reason
   BitVM can commit to values with Winternitz signatures in tapscript.
2. **The spend needs no signing.** The script checks hashes, not a curve signature, so
   there is no sighash to sign. The witness is pure data: the Winternitz signature
   elements, the script, and the control block.

The taproot internal key is the BIP341 nothing-up-my-sleeve point, so there is no
classical key-path spender.

## Honest limits, and the path to production

1. **The message is fixed at lock time, not bound to the spending transaction.** A
   watcher who sees the witness in the mempool can copy it onto their own transaction
   spending the same UTXO. Binding the signature to the spending tx (so the message is
   the sighash) needs `OP_CHECKSIGFROMSTACK` or `OP_CAT`. Both exist on Bitcoin
   Inquisition signet and on Elements today; neither is on mainnet or testnet4. This is
   the single remaining step and it does not change the hash-based verification proven
   here.
2. **The taproot key-path is a quantum hole.** A taproot output key is a curve point on
   chain, and Shor can solve its discrete log, giving a key-path spend that bypasses our
   script. A NUMS internal key blocks a classical spender but not a quantum one. The fix
   is a pre-taproot P2WSH output, which has no key path at all. P2WSH still carries the
   201-opcode limit, so a production build needs a compact Winternitz parameter (or
   Bitcoin-native post-quantum via BIP-360 P2QRH, which removes the problem entirely).
3. **One-time.** A Winternitz key must be used for one signature only. The gateway uses a
   fresh key per redemption, which fits its one-receipt-per-crossing model.

The production target is P2WSH (no key path) + a compact Winternitz verifier + CAT or
CSFS for transaction binding, prototyped on Bitcoin Inquisition signet. When Bitcoin
ships native post-quantum outputs, the vault migrates onto them and none of this script
plumbing is needed.

## How it composes

- Coinbase mined into a hash address: born with no key exposed (the coinbase has no
  signature) and rests with no key on chain.
- This work: the coin can be redeemed by a hash-based signature, so even the move
  exposes no crackable key.
- The hygiene sweep (`quantum_hygiene_sweep.py`): the same exposure model applied to a
  miner's existing coins, self-custodial, on mainnet today.

Together these are the three states of a quantum-dark bitcoin: born dark, kept dark,
moved dark.
