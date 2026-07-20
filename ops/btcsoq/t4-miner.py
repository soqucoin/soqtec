#!/usr/bin/env python3
"""Coinbase-only CPU miner for testnet4 min-difficulty windows (regtest = test mode).

testnet4 keeps the 20-minute rule: a block whose timestamp is more than 20 minutes
past the previous block may use the minimum difficulty (nBits 0x1d00ffff). We
future-date the header to prev_time + 20min + 1s (legal up to ~2h ahead of wall
clock) and grind the nonce with bitcoin-util. Blocks contain only our coinbase,
so the merkle root is the coinbase txid and no witness commitment is required.

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

RPC_ENV = "/root/.btcsoq-rpc.env"
MIN_DIFF_BITS = 0x1D00FFFF
MAX_FUTURE_SLACK = 7000  # stay inside the 7200s future-block consensus limit


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
        cmd += list(args)
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


def build_coinbase(height, value_sats, spk_hex, extranonce):
    scriptsig = script_num(height) + b"/soqucoin fortress/" + extranonce
    spk = bytes.fromhex(spk_hex)
    tx = (
        struct.pack("<i", 2)
        + b"\x01"                       # 1 input
        + b"\x00" * 32 + b"\xff" * 4    # null prevout
        + varint(len(scriptsig)) + scriptsig
        + b"\xff" * 4                   # sequence
        + b"\x01"                       # 1 output
        + struct.pack("<q", value_sats)
        + varint(len(spk)) + spk
        + b"\x00" * 4                   # locktime
    )
    return tx


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
    ap.add_argument("--address", required=True, help="payout address")
    ap.add_argument("--cores", default="", help="taskset core list, e.g. 4-7")
    ap.add_argument("--once", action="store_true", help="exit after one solved block")
    args = ap.parse_args()

    cli = Cli(args.network)
    info = cli("validateaddress", args.address)
    if not info.get("isvalid"):
        sys.exit(f"invalid address {args.address}")
    spk_hex = info["scriptPubKey"]
    log(f"mining {args.network} → {args.address} (cores={args.cores or 'all'})")

    attempts = 0
    while True:
        try:
            tmpl = cli("getblocktemplate", json.dumps({"rules": ["segwit"]}))
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
            value = tmpl["coinbasevalue"] - fees  # coinbase-only block: subsidy only

            coinbase = build_coinbase(height, value, spk_hex, os.urandom(8))
            txid = sha256d(coinbase)

            header = (
                struct.pack("<i", tmpl["version"])
                + bytes.fromhex(prev)[::-1]
                + txid                       # merkle root = single-tx block
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

            block_hex = solved + varint(1).hex() + coinbase.hex()
            res = cli("submitblock", block_hex)
            block_hash = sha256d(bytes.fromhex(solved))[::-1].hex()
            if res in ("", None):
                log(f"*** BLOCK ACCEPTED h={height} {block_hash} ({value} sats) after {dt:.0f}s")
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
