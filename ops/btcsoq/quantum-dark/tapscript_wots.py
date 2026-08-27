"""Build and spend a Bitcoin UTXO whose ONLY spending condition is a valid
Winternitz (hash-based) one-time signature. No elliptic-curve key is used to
authorize the spend, so nothing in the spending path is breakable by Shor.

We express the Winternitz verifier as a tapscript leaf: for each chain, walk
the signature element the remaining number of HASH160 steps and require it to
equal the committed public-key element. Tapscript has no 201-opcode limit, so
the whole verifier fits. The taproot internal key is the BIP341 "nothing up my
sleeve" point, so there is no usable key-path spend.

Honest scope, stated in the write-up: the message the signature commits to is
fixed at lock time, not the live spending transaction. Binding it to the
spending tx (so a mempool watcher cannot copy the witness onto their own tx)
needs OP_CHECKSIGFROMSTACK or OP_CAT, which exist on Bitcoin Inquisition signet
and Elements today, not on mainnet or testnet4. That binding is the one
remaining step, and it changes none of the hash-based verification proven here.

Usage:
  tapscript_wots.py addr                          -> print the P2TR address
  tapscript_wots.py spend TXID VOUT AMT DEST      -> print raw spend tx hex
"""

import json
import sys
import hashlib

from buidl.tx import Tx, TxIn, TxOut
from buidl.script import Script, address_to_script_pubkey
from buidl.taproot import TapRoot, TapLeaf
from buidl.ecc import S256Point
from buidl.witness import Witness
from buidl.bech32 import convertbits, bech32m_create_checksum

from winternitz import WOTS, hash160

BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def regtest_p2tr_address(program32: bytes) -> str:
    """Encode a v1 (taproot) witness program with the regtest 'bcrt' HRP,
    which buidl itself does not emit."""
    data = [1] + convertbits(program32, 8, 5)          # witver 1 + payload
    checksum = bech32m_create_checksum("bcrt", data)
    return "bcrt1" + "".join(BECH32_ALPHABET[d] for d in data + checksum)

STATE = __file__.rsplit("/", 1)[0] + "/wots_state.json"
NETWORK = "regtest"

# BIP341 unspendable-key-path NUMS point (H = lift_x of SHA256(G)).
NUMS_X = bytes.fromhex("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0")
NUMS = S256Point.parse(b"\x02" + NUMS_X)

# Fixed demo commitment (in production this becomes the spending-tx sighash,
# bound via CAT/CSFS). A 32-bit message keeps the verifier small and legible.
COMMITMENT = b"BTCSOQ-quantum-dark-redemption-v1"
SEED = hashlib.sha256(b"demo-seed-do-not-reuse-in-production").digest()

OP_HASH160 = 0xA9
OP_EQUALVERIFY = 0x88
OP_1 = 0x51


def build_wots():
    # w=16, 32-bit message -> small chain count, real Winternitz with checksum.
    return WOTS(w=16, msg_bits=32, hashfn=hash160, digest_len=20)


def verifier_script(pk, digits):
    """Tapscript that verifies the W-OTS signature for the fixed commitment.
    Witness supplies sig[0..l-1] in order, so the stack top is sig[l-1]; we emit
    chain blocks from l-1 down to 0 to match."""
    w = build_wots()
    cmds = []
    for i in reversed(range(len(pk))):
        remaining = (w.w - 1) - digits[i]
        cmds += [OP_HASH160] * remaining      # finish walking the chain
        cmds += [pk[i]]                        # push committed pubkey element
        cmds += [OP_EQUALVERIFY]
    cmds += [OP_1]                             # leave a truthy stack
    return Script(cmds)


def taproot_for(pk, digits):
    leaf = TapLeaf(verifier_script(pk, digits))
    return TapRoot(NUMS, leaf), leaf


def cmd_addr():
    w = build_wots()
    sk, pk = w.keygen(seed=SEED)
    digits = w._digits(w.hashfn(COMMITMENT))
    tr, _ = taproot_for(pk, digits)
    program = tr.script_pubkey().commands[1]           # the 32-byte output key
    addr = regtest_p2tr_address(program)
    json.dump({
        "pk": [x.hex() for x in pk],
        "digits": digits,
        "chains": len(pk),
        "address": addr,
    }, open(STATE, "w"))
    print(addr)


def spk_from_hex(spk_hex):
    """Build a buidl Script from a raw scriptPubKey hex (v0/v1 witness output)."""
    b = bytes.fromhex(spk_hex)
    return Script([b[0], b[2:]])          # [witver opcode, pushdata program]


def cmd_spend(txid, vout, amount, dest_spk_hex):
    w = build_wots()
    sk, pk = w.keygen(seed=SEED)
    digits = w._digits(w.hashfn(COMMITMENT))
    sig = w.sign(sk, COMMITMENT)            # the hash-based signature (witness data)
    assert w.verify(pk, COMMITMENT, sig), "reference verify failed"

    tr, leaf = taproot_for(pk, digits)
    control = tr.control_block(leaf)

    fee = 400
    tx_in = TxIn(bytes.fromhex(txid), int(vout))
    tx_out = TxOut(int(amount) - fee, spk_from_hex(dest_spk_hex))
    tx = Tx(2, [tx_in], [tx_out], network=NETWORK, segwit=True)

    # Witness: sig elements (sig[0]..sig[l-1]) then leaf script then control block.
    items = [bytes(s) for s in sig]
    if len(sys.argv) > 6 and sys.argv[6] == "forge":
        items[0] = hash160(items[0])   # a value the signer could not have known

    items.append(leaf.tap_script.raw_serialize())
    items.append(control.serialize() if hasattr(control, "serialize") else bytes(control))
    tx.tx_ins[0].witness = Witness(items)
    print(tx.serialize().hex())


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "addr":
        cmd_addr()
    elif len(sys.argv) in (6, 7) and sys.argv[1] == "spend":
        cmd_spend(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    else:
        print(__doc__)
        sys.exit(1)
