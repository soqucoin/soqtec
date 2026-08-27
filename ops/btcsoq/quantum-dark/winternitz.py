"""Winternitz one-time signature (W-OTS), the hash-based scheme behind a
quantum-dark redemption.

Security rests only on the preimage and second-preimage resistance of the hash.
Grover's algorithm gives at most a square-root speedup against a hash, so a
256-bit hash keeps ~128-bit security against a quantum attacker. There is no
Shor-style break, because there is no discrete-log or factoring structure here:
this is the reason a hash-based signature is post-quantum.

This module is the reference implementation. The on-chain half (verifying a
signature like this inside Bitcoin Script) is built in tapscript_wots.py.

Parameters follow the standard W-OTS construction:
  - hash H = SHA256 (RIPEMD160(SHA256(.)) = HASH160 is used on-chain to keep
    the committed values 20 bytes; here we stay with the full 32-byte digest
    for the reference and switch to HASH160 for the compact on-chain variant).
  - Winternitz parameter w: each signature "digit" covers log2(w) message bits.
    A digit is signed by walking a hash chain of length (w-1). Larger w means
    fewer chains (shorter signature) but longer chains (more hashing).
"""

import hashlib
import os


def H(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def hash160(b: bytes) -> bytes:
    return hashlib.new("ripemd160", hashlib.sha256(b).digest()).digest()


def _chain(x: bytes, n: int, hashfn) -> bytes:
    """Walk the hash chain n steps: hashfn applied n times."""
    for _ in range(n):
        x = hashfn(x)
    return x


class WOTS:
    def __init__(self, w: int = 16, msg_bits: int = 256, hashfn=H, digest_len: int = 32):
        assert w in (4, 16, 256), "w must be a power of two we tile cleanly"
        self.w = w
        self.log2w = w.bit_length() - 1          # bits per digit
        self.hashfn = hashfn
        self.digest_len = digest_len
        self.msg_bits = msg_bits
        self.l1 = (msg_bits + self.log2w - 1) // self.log2w        # message digits
        # checksum digits: checksum max = l1 * (w-1), count digits to hold it
        csum_max = self.l1 * (w - 1)
        csum_bits = csum_max.bit_length()
        self.l2 = (csum_bits + self.log2w - 1) // self.log2w
        self.l = self.l1 + self.l2               # total chains

    # ---- key generation ----
    def keygen(self, seed: bytes = None):
        seed = seed or os.urandom(32)
        # each chain's secret start is derived from the seed and its index
        sk = [self.hashfn(seed + i.to_bytes(2, "big")) for i in range(self.l)]
        # public key = each secret walked to the end of its chain (w-1 steps)
        pk = [_chain(x, self.w - 1, self.hashfn) for x in sk]
        return sk, pk

    # ---- digit decomposition with checksum ----
    def _digits(self, msg_digest: bytes):
        # message digits (base w), most-significant first
        val = int.from_bytes(msg_digest, "big")
        digits = []
        for _ in range(self.l1):
            digits.append(val & (self.w - 1))
            val >>= self.log2w
        digits = digits[::-1]
        # checksum = sum(w-1 - d_i), which makes the scheme forgery-resistant:
        # increasing any message digit forces some checksum digit to decrease,
        # and a chain cannot be walked backwards without inverting the hash.
        csum = sum((self.w - 1) - d for d in digits)
        cdigits = []
        for _ in range(self.l2):
            cdigits.append(csum & (self.w - 1))
            csum >>= self.log2w
        return digits + cdigits[::-1]

    # ---- sign / verify ----
    def sign(self, sk, msg: bytes):
        d = self._digits(self.hashfn(msg))
        return [_chain(sk[i], d[i], self.hashfn) for i in range(self.l)]

    def verify(self, pk, msg: bytes, sig) -> bool:
        d = self._digits(self.hashfn(msg))
        for i in range(self.l):
            # finish walking each chain from the signature to its end; must land
            # on the public key value.
            if _chain(sig[i], (self.w - 1) - d[i], self.hashfn) != pk[i]:
                return False
        return True


if __name__ == "__main__":
    print("Winternitz OTS reference — self test\n")
    for w in (4, 16, 256):
        wots = WOTS(w=w)
        sk, pk = wots.keygen(seed=b"quantum-dark-demo-seed-000000000")
        msg = b"redeem 50 tBTC to bc1q...fresh hash address"
        sig = wots.sign(sk, msg)
        ok = wots.verify(pk, msg, sig)
        # forgery attempt: a different message must fail
        forged = wots.verify(pk, b"redeem 50 tBTC to bc1q...ATTACKER", sig)
        # tamper attempt: flip a signature element
        bad = list(sig); bad[0] = H(bad[0])
        tampered = wots.verify(pk, msg, bad)
        print(f"w={w:>3}  chains={wots.l:>3}  sig_bytes={wots.l*wots.digest_len:>4}  "
              f"verify(valid)={ok}  verify(other-msg)={forged}  verify(tampered)={tampered}")
        assert ok and not forged and not tampered
    print("\nAll checks pass: valid signatures verify, forged and tampered ones are rejected.")
    print("Security is hash-based only. No elliptic curve, no discrete log, nothing Shor breaks.")
