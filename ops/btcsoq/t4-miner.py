#!/usr/bin/env python3
"""Coinbase-only CPU miner for testnet4 min-difficulty windows (regtest = test mode),
with optional zero-exposure fortress crossing.

testnet4 keeps the 20-minute rule: a block whose timestamp is more than 20 minutes
past the previous block may use the minimum difficulty (nBits 0x1d00ffff). We
future-date the header to prev_time + 20min + 1s (legal up to ~2h ahead of wall
clock) and grind the nonce with bitcoin-util.

Crossing mode (--crossing-ssq): each attempt pre-signs a payment from the release
wallet to a standing boundary deposit intent and embeds it in the block next to the
coinbase. The transaction is never broadcast; its first public appearance is at
1 confirmation inside our own block, so the pubkey is never visible while spendable
(the mempool race a quantum adversary needs does not exist). Requires a BIP141
witness commitment in the coinbase since the crossing spend is segwit. Inputs are
locked in-wallet (lockUnspents) so the gateway's own beat/anchor sends cannot race
them; every attempt unlocks and rebuilds fresh so nothing goes stale.

Payout goes to --address (btcsoq-release wallet). Run under systemd with
Nice=19 + CPUAffinity so the demo stack is unaffected.
"""
import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request

RPC_ENV = "/root/.btcsoq-rpc.env"
MIN_DIFF_BITS = 0x1D00FFFF
MAX_FUTURE_SLACK = 7100  # stay inside the 7200s future-block consensus limit (100s NTP margin)
RELAYER_PORT = {"testnet4": 3006, "regtest": 3005}
WITNESS_RESERVED = b"\x00" * 32


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


def sha256d(b):
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()


def load_rpc_creds(network):
    prefix = "BTC_T4_" if network == "testnet4" else "BTC_RT_"
    user = passwd = None
    with open(RPC_ENV) as f:
        for line in f:
            line = line.strip()
            if line.startswith(prefix + "RPC_USER="):
                user = line.split("=", 1)[1]
            elif line.startswith(prefix + "RPC_PASS="):
                passwd = line.split("=", 1)[1]
    if not user or not passwd:
        sys.exit(f"missing {prefix}RPC_USER/PASS in {RPC_ENV}")
    return user, passwd


class Cli:
    def __init__(self, network):
        user, passwd = load_rpc_creds(network)
        flag = "-testnet4" if network == "testnet4" else "-regtest"
        self.base = ["bitcoin-cli", flag, f"-rpcuser={user}", f"-rpcpassword={passwd}"]

    def __call__(self, *args, wallet=None):
        cmd = list(self.base)
        if wallet:
            cmd.append(f"-rpcwallet={wallet}")
        cmd += [a if isinstance(a, str) else json.dumps(a) for a in args]
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError(f"bitcoin-cli {args[0]}: {out.stderr.strip()}")
        raw = out.stdout.strip()
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return raw


def script_num(n):
    """Minimal CScriptNum encoding (BIP34 height push)."""
    if n == 0:
        return b"\x00"
    out = bytearray()
    v = n
    while v:
        out.append(v & 0xFF)
        v >>= 8
    if out[-1] & 0x80:
        out.append(0)
    return bytes([len(out)]) + bytes(out)


def varint(n):
    if n < 0xFD:
        return struct.pack("<B", n)
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    return b"\xfe" + struct.pack("<I", n)


def build_coinbase(height, value_sats, spk_hex, extranonce, commitment=None):
    """Returns (stripped_serialization_for_txid, block_serialization).

    Without a commitment both are the same legacy bytes. With one, the block
    serialization carries the segwit marker/flag and the reserved witness item,
    and the outputs gain the OP_RETURN commitment (BIP141).
    """
    scriptsig = script_num(height) + b"/soqucoin fortress/" + extranonce
    spk = bytes.fromhex(spk_hex)
    vin = (
        b"\x01"
        + b"\x00" * 32 + b"\xff" * 4
        + varint(len(scriptsig)) + scriptsig
        + b"\xff" * 4
    )
    outs = [struct.pack("<q", value_sats) + varint(len(spk)) + spk]
    if commitment is not None:
        cscript = b"\x6a\x24\xaa\x21\xa9\xed" + commitment
        outs.append(struct.pack("<q", 0) + varint(len(cscript)) + cscript)
    vout = varint(len(outs)) + b"".join(outs)
    version = struct.pack("<i", 2)
    locktime = b"\x00" * 4

    stripped = version + vin + vout + locktime
    if commitment is None:
        return stripped, stripped
    witness = b"\x01" + varint(len(WITNESS_RESERVED)) + WITNESS_RESERVED
    with_wit = version + b"\x00\x01" + vin + vout + witness + locktime
    return stripped, with_wit


def create_intent(network, ssq_address):
    port = RELAYER_PORT[network]
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/btc/intent",
        data=json.dumps({"ssqAddress": ssq_address}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        body = json.loads(r.read())
    if not body.get("ok"):
        raise RuntimeError(f"intent creation refused: {body}")
    return body["intentId"], body["btcDepositAddress"]


def build_crossing_tx(cli, wallet, deposit_addr, sats):
    """Fund + sign (never broadcast) a payment to the boundary. Returns
    (raw_hex, txid_internal, wtxid_internal, fee_sats)."""
    cli("lockunspent", "true", wallet=wallet)  # release last attempt's locks
    funded = cli(
        "walletcreatefundedpsbt", [], {deposit_addr: round(sats / 1e8, 8)}, 0,
        {"fee_rate": 1, "lockUnspents": True},
        wallet=wallet,
    )
    processed = cli("walletprocesspsbt", funded["psbt"], wallet=wallet)
    final = cli("finalizepsbt", processed["psbt"], wallet=wallet)
    if not final.get("complete"):
        raise RuntimeError("crossing psbt did not finalize")
    raw = final["hex"]
    dec = cli("decoderawtransaction", raw)
    txid_i = bytes.fromhex(dec["txid"])[::-1]
    wtxid_i = bytes.fromhex(dec["hash"])[::-1]
    fee_sats = round(funded["fee"] * 1e8)
    return raw, txid_i, wtxid_i, fee_sats


def grind(header_hex, cores):
    cmd = []
    if cores:
        cmd += ["taskset", "-c", cores]
    cmd += ["nice", "-n", "19", "bitcoin-util", "grind", header_hex]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        return None  # nonce space exhausted without a solution — rebuild and retry
    return out.stdout.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", choices=["testnet4", "regtest"], required=True)
    ap.add_argument("--address", required=True, help="coinbase payout address")
    ap.add_argument("--cores", default="", help="taskset core list, e.g. 4-7")
    ap.add_argument("--once", action="store_true", help="exit after one solved block")
    ap.add_argument("--crossing-ssq", default="", help="ssq address; enables in-block fortress crossing")
    ap.add_argument("--crossing-sats", type=int, default=10000)
    ap.add_argument("--wallet", default="btcsoq-release")
    args = ap.parse_args()

    cli = Cli(args.network)
    info = cli("validateaddress", args.address)
    if not info.get("isvalid"):
        sys.exit(f"invalid address {args.address}")
    spk_hex = info["scriptPubKey"]

    intent_id = deposit_addr = None
    if args.crossing_ssq:
        try:
            intent_id, deposit_addr = create_intent(args.network, args.crossing_ssq)
            log(f"crossing armed: intent {intent_id} boundary {deposit_addr} ({args.crossing_sats} sats/block)")
        except Exception as e:
            log(f"crossing DISARMED (intent creation failed: {e!r}); mining empty blocks")

    log(f"mining {args.network} → {args.address} (cores={args.cores or 'all'})")

    attempts = 0
    while True:
        try:
            tmpl = cli("getblocktemplate", {"rules": ["segwit"]})
            prev = tmpl["previousblockhash"]
            height = tmpl["height"]
            prev_hdr = cli("getblockheader", prev)

            if args.network == "testnet4":
                block_time = max(prev_hdr["mediantime"] + 1, prev_hdr["time"] + 20 * 60 + 1)
                wait = block_time - (int(time.time()) + MAX_FUTURE_SLACK)
                if wait > 0:
                    log(f"tip future-dated; waiting {wait}s for the clock")
                    time.sleep(min(wait, 60))
                    continue
                bits = MIN_DIFF_BITS
            else:
                block_time = max(tmpl["curtime"], tmpl["mintime"])
                bits = int(tmpl["bits"], 16)

            fees = sum(t.get("fee", 0) for t in tmpl.get("transactions", []))
            subsidy = tmpl["coinbasevalue"] - fees

            crossing = None
            if deposit_addr:
                try:
                    crossing = build_crossing_tx(cli, args.wallet, deposit_addr, args.crossing_sats)
                except Exception as e:
                    log(f"crossing build failed ({e!r}); this block goes empty")

            if crossing:
                raw_cross, cross_txid, cross_wtxid, cross_fee = crossing
                wit_root = sha256d(b"\x00" * 32 + cross_wtxid)
                commitment = sha256d(wit_root + WITNESS_RESERVED)
                cb_stripped, cb_block = build_coinbase(
                    height, subsidy + cross_fee, spk_hex, os.urandom(8), commitment)
                cb_txid = sha256d(cb_stripped)
                merkle = sha256d(cb_txid + cross_txid)
                body = varint(2).hex() + cb_block.hex() + raw_cross
                ntx = 2
            else:
                cb_stripped, cb_block = build_coinbase(height, subsidy, spk_hex, os.urandom(8))
                merkle = sha256d(cb_stripped)
                body = varint(1).hex() + cb_block.hex()
                ntx = 1

            header = (
                struct.pack("<i", tmpl["version"])
                + bytes.fromhex(prev)[::-1]
                + merkle
                + struct.pack("<I", block_time)
                + struct.pack("<I", bits)
                + struct.pack("<I", 0)
            )

            attempts += 1
            t0 = time.time()
            solved = grind(header.hex(), args.cores)
            dt = time.time() - t0
            if solved is None:
                log(f"attempt {attempts} h={height}: nonce space dry after {dt:.0f}s, rebuilding")
                continue

            if cli("getbestblockhash") != prev:
                log(f"attempt {attempts} h={height}: solved after {dt:.0f}s but STALE, discarding")
                continue

            res = cli("submitblock", solved + body)
            block_hash = sha256d(bytes.fromhex(solved))[::-1].hex()
            if res in ("", None):
                log(f"*** BLOCK ACCEPTED h={height} {block_hash} txs={ntx} after {dt:.0f}s")
                if ntx == 2:
                    log(f"*** ZERO-EXPOSURE CROSSING: {cross_txid[::-1].hex()} confirmed in our own "
                        f"block, never broadcast (intent {intent_id})")
                if args.once:
                    return
            else:
                log(f"attempt {attempts} h={height}: submitblock said {res!r}")
        except RuntimeError as e:
            log(f"rpc error: {e}; retrying in 15s")
            time.sleep(15)
        except Exception as e:
            log(f"unexpected: {e!r}; retrying in 30s")
            time.sleep(30)


if __name__ == "__main__":
    main()
