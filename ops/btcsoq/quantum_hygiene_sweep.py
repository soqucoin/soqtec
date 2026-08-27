#!/usr/bin/env python3
"""Quantum Hygiene Sweep.

Read-only analysis tool for Bitcoin miners. Classifies every UTXO held by a
set of addresses as quantum-EXPOSED or quantum-LATENT, then proposes a sweep
plan that consolidates the exposed coins into fresh hash-locked (latent)
destinations.

First principles
----------------
A Bitcoin public key is only breakable by Shor's algorithm once the key is
visible on chain. So:

EXPOSED (public key is on chain, attackable now)
  * P2PK outputs: the raw pubkey sits in the output script.
  * ALL Taproot outputs (P2TR, bc1p / tb1p / bcrt1p): the 32-byte x-only
    public key IS the witness program. It is on chain the instant the output
    is created, spent or not.
  * Any address that has EVER been spent from: the spend reveals the pubkey in
    the scriptSig or witness, permanently. Address reuse means every current
    and future UTXO at that address is exposed.

LATENT (public key is still hidden behind a hash)
  * P2PKH, P2WPKH, P2WSH, P2SH addresses that have RECEIVED but NEVER SPENT.
    The output commits to HASH160 or SHA256 only; the key stays secret until
    the first spend.

This tool never touches a private key, never builds or broadcasts a real
transaction, and only reads the public mempool.space API.
"""

import argparse
import json
import sys
import time

# Prefer requests, fall back to urllib so the tool runs with only stdlib.
try:
    import requests  # type: ignore

    _HAVE_REQUESTS = True
except ImportError:  # pragma: no cover - environment dependent
    _HAVE_REQUESTS = False
    import urllib.error
    import urllib.request


API_BASES = {
    "testnet4": "https://mempool.space/testnet4/api",
    "mainnet": "https://mempool.space/api",
}

# Rough virtual-byte sizes for a consolidating P2WPKH sweep. These are close
# enough for a fee estimate; the real signed size depends on input types.
VBYTES_TX_OVERHEAD = 11        # version, locktime, segwit marker/flag, counts
VBYTES_PER_INPUT_P2WPKH = 68   # spending a v0 segwit key-hash input
VBYTES_PER_INPUT_LEGACY = 148  # spending a legacy P2PKH input (worst case)
VBYTES_PER_INPUT_TAPROOT = 58  # spending a key-path taproot input
VBYTES_PER_OUTPUT_P2WPKH = 31  # a fresh P2WPKH destination


class ScriptType:
    P2PKH = "P2PKH"
    P2SH = "P2SH"
    P2WPKH = "P2WPKH"
    P2WSH = "P2WSH"
    P2TR = "P2TR (taproot)"
    UNKNOWN = "UNKNOWN"


def classify_script_type(address):
    """Infer the script type from an address prefix or format."""
    a = address.strip()
    low = a.lower()

    # Bech32 / bech32m. Human-readable part then '1' separator.
    if low.startswith(("bc1", "tb1", "bcrt1")):
        # Strip the hrp to look at the witness version character.
        if low.startswith("bcrt1"):
            body = low[5:]
        else:
            body = low[3:]
        if not body:
            return ScriptType.UNKNOWN
        wit_char = body[0]
        if wit_char == "p":
            # bech32m witness v1 -> taproot
            return ScriptType.P2TR
        if wit_char == "q":
            # witness v0. length distinguishes P2WPKH (20-byte) vs P2WSH (32).
            # 42-char P2WPKH mainnet, longer for P2WSH. Use length heuristic.
            if len(a) >= 60:
                return ScriptType.P2WSH
            return ScriptType.P2WPKH
        return ScriptType.UNKNOWN

    # Base58 legacy.
    if a.startswith("1"):
        return ScriptType.P2PKH
    if a.startswith(("m", "n")):  # testnet P2PKH
        return ScriptType.P2PKH
    if a.startswith("3"):
        return ScriptType.P2SH
    if a.startswith("2"):  # testnet P2SH
        return ScriptType.P2SH

    return ScriptType.UNKNOWN


def http_get_json(url, retries=3, backoff=1.5):
    """GET a URL and parse JSON, using requests or urllib."""
    last_err = None
    for attempt in range(retries):
        try:
            if _HAVE_REQUESTS:
                resp = requests.get(url, timeout=20)
                if resp.status_code == 429:
                    raise RuntimeError("rate limited (429)")
                resp.raise_for_status()
                return resp.json()
            req = urllib.request.Request(url, headers={"User-Agent": "qhs/1.0"})
            with urllib.request.urlopen(req, timeout=20) as fh:  # nosec B310
                return json.loads(fh.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - report and retry
            last_err = exc
            if attempt < retries - 1:
                time.sleep(backoff * (attempt + 1))
    raise RuntimeError("GET failed for {}: {}".format(url, last_err))


def fetch_address_stats(base, address):
    """Return (spent_txo_count, funded_txo_count) for an address."""
    data = http_get_json("{}/address/{}".format(base, address))
    chain = data.get("chain_stats", {})
    mem = data.get("mempool_stats", {})
    spent = chain.get("spent_txo_count", 0) + mem.get("spent_txo_count", 0)
    funded = chain.get("funded_txo_count", 0) + mem.get("funded_txo_count", 0)
    return spent, funded


def fetch_utxos(base, address):
    """Return the UTXO list for an address."""
    return http_get_json("{}/address/{}/utxo".format(base, address))


def classify_utxo(script_type, has_spent):
    """Return (is_exposed, reason) for a single UTXO.

    Exposure depends on the script type and whether the address has ever been
    spent from. Taproot is always exposed. Any spent address is exposed.
    Hash-locked outputs that have never been spent are latent.
    """
    if script_type == ScriptType.P2TR:
        return True, "taproot: x-only pubkey is the witness program, on chain now"

    if has_spent:
        return True, "address has spent history: pubkey revealed in a past spend"

    if script_type in (
        ScriptType.P2PKH,
        ScriptType.P2WPKH,
        ScriptType.P2WSH,
        ScriptType.P2SH,
    ):
        return False, "hash address, never spent: key still hidden (latent)"

    # P2PK never produces a normal address, so unknown formats are flagged
    # conservatively as exposed rather than assumed safe.
    return True, "unknown script type: treated as exposed (conservative)"


def input_vbytes_for(script_type):
    if script_type == ScriptType.P2PKH:
        return VBYTES_PER_INPUT_LEGACY
    if script_type == ScriptType.P2TR:
        return VBYTES_PER_INPUT_TAPROOT
    # P2WPKH and, as an approximation, P2SH-wrapped and P2WSH single-key.
    return VBYTES_PER_INPUT_P2WPKH


def analyze(addresses, network, sat_vb, dest_count):
    base = API_BASES[network]
    rows = []
    errors = []

    for addr in addresses:
        stype = classify_script_type(addr)
        try:
            spent, funded = fetch_address_stats(base, addr)
            utxos = fetch_utxos(base, addr)
        except Exception as exc:  # noqa: BLE001
            errors.append((addr, str(exc)))
            continue

        has_spent = spent > 0
        for u in utxos:
            value = u.get("value", 0)
            confirmed = u.get("status", {}).get("confirmed", False)
            is_exposed, reason = classify_utxo(stype, has_spent)
            rows.append(
                {
                    "address": addr,
                    "script_type": stype,
                    "txid": u.get("txid", ""),
                    "vout": u.get("vout", 0),
                    "value": value,
                    "confirmed": confirmed,
                    "exposed": is_exposed,
                    "reason": reason,
                }
            )

    return rows, errors


def sats_to_btc(sats):
    return sats / 1e8


def build_report(rows, errors, network, sat_vb, dest_count):
    lines = []
    w = lines.append

    exposed = [r for r in rows if r["exposed"]]
    latent = [r for r in rows if not r["exposed"]]
    exp_val = sum(r["value"] for r in exposed)
    lat_val = sum(r["value"] for r in latent)
    total_val = exp_val + lat_val

    w("=" * 78)
    w("QUANTUM HYGIENE SWEEP  ({})".format(network))
    w("=" * 78)
    w("")
    w("A Bitcoin pubkey is only quantum-attackable once it appears on chain.")
    w("This report splits your coins into EXPOSED (key already visible) and")
    w("LATENT (key still hidden behind a hash).")
    w("")

    if errors:
        w("LOOKUP ERRORS")
        for addr, msg in errors:
            w("  {}  ->  {}".format(addr, msg))
        w("")

    # Totals
    w("TOTALS")
    w("  {:<10} {:>6} UTXOs   {:>16} sats   {:>14.8f} BTC".format(
        "EXPOSED", len(exposed), exp_val, sats_to_btc(exp_val)))
    w("  {:<10} {:>6} UTXOs   {:>16} sats   {:>14.8f} BTC".format(
        "LATENT", len(latent), lat_val, sats_to_btc(lat_val)))
    w("  {:<10} {:>6} UTXOs   {:>16} sats   {:>14.8f} BTC".format(
        "TOTAL", len(rows), total_val, sats_to_btc(total_val)))
    if total_val > 0:
        w("  exposed share: {:.1f}% of value".format(100.0 * exp_val / total_val))
    w("")

    # Per-UTXO table
    w("PER-UTXO DETAIL")
    header = "  {:<6} {:<16} {:>13} {:<5} {:<10}  {}".format(
        "STATE", "SCRIPT", "VALUE(sats)", "CONF", "TXID", "REASON")
    w(header)
    w("  " + "-" * 74)
    for r in sorted(rows, key=lambda x: (not x["exposed"], -x["value"])):
        state = "EXPOSE" if r["exposed"] else "latent"
        conf = "yes" if r["confirmed"] else "MEMPOOL"
        txid_short = (r["txid"][:8] + "..") if r["txid"] else ""
        w("  {:<6} {:<16} {:>13} {:<5} {:<10}  {}".format(
            state,
            r["script_type"],
            r["value"],
            conf,
            txid_short,
            r["reason"],
        ))
    if not rows:
        w("  (no UTXOs found at the supplied addresses)")
    w("")

    # Sweep plan
    w("SWEEP PLAN")
    if not exposed:
        w("  Nothing to sweep. No exposed UTXOs found.")
        w("")
        return "\n".join(lines)

    n_in = len(exposed)
    in_vbytes = sum(input_vbytes_for(r["script_type"]) for r in exposed)
    out_vbytes = dest_count * VBYTES_PER_OUTPUT_P2WPKH
    est_vbytes = VBYTES_TX_OVERHEAD + in_vbytes + out_vbytes
    est_fee = int(round(est_vbytes * sat_vb))
    swept_after_fee = exp_val - est_fee

    w("  Move {} exposed UTXO(s) worth {} sats ({:.8f} BTC)".format(
        n_in, exp_val, sats_to_btc(exp_val)))
    w("  into {} fresh P2WPKH destination(s) (never-used hash addresses).".format(
        dest_count))
    w("")
    w("  Fee estimate at {} sat/vB:".format(sat_vb))
    w("    inputs         : {} UTXO -> ~{} vB".format(n_in, in_vbytes))
    w("    outputs        : {} dest -> ~{} vB".format(dest_count, out_vbytes))
    w("    tx overhead    : ~{} vB".format(VBYTES_TX_OVERHEAD))
    w("    total size     : ~{} vB".format(est_vbytes))
    w("    estimated fee  : ~{} sats ({:.8f} BTC)".format(
        est_fee, sats_to_btc(est_fee)))
    if swept_after_fee > 0:
        w("    net swept      : ~{} sats ({:.8f} BTC)".format(
            swept_after_fee, sats_to_btc(swept_after_fee)))
    else:
        w("    WARNING: estimated fee exceeds exposed value at this sat/vB.")
    w("")

    # Exposure profile after the sweep
    w("EXPOSURE PROFILE AFTER SWEEP")
    w("  Before : {} exposed / {} latent  ({:.8f} BTC exposed)".format(
        len(exposed), len(latent), sats_to_btc(exp_val)))
    w("  After  : 0 exposed / {} latent   (destinations rest behind a hash)".format(
        len(latent) + dest_count))
    w("           swept value now sits at fresh, never-spent P2WPKH addresses.")
    w("")

    # Honest tradeoff
    w("HONEST TRADEOFF (read this)")
    w("  Sweeping SPENDS the exposed UTXO. The spend itself briefly reveals the")
    w("  key in the witness at broadcast time. After the sweep confirms, the")
    w("  coin rests LATENT at a fresh hash address whose key has never been")
    w("  shown. So a sweep converts PERMANENT exposure (a naked key sitting on")
    w("  chain for years) into ONE short, controlled exposure window.")
    w("")
    w("  Minimize that window:")
    w("    - sweep when the mempool is calm so it confirms fast")
    w("    - do it before a quantum threat is imminent, not during a panic")
    w("    - never reuse the destination address afterward")
    w("")
    w("  This tool is read-only. It plans the sweep. It does not sign, build,")
    w("  or broadcast anything. Signing stays on your own device with your keys.")
    w("")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Classify Bitcoin UTXOs as quantum-exposed or latent and "
        "plan a sweep to fresh hash-locked storage. Read-only."
    )
    parser.add_argument("addresses", nargs="*", help="Bitcoin addresses to scan")
    parser.add_argument(
        "--network",
        choices=["testnet4", "mainnet"],
        default="testnet4",
        help="which chain to query (default: testnet4)",
    )
    parser.add_argument(
        "--sat-vb",
        type=float,
        default=2.0,
        help="fee rate in sat/vB for the sweep estimate (default: 2.0)",
    )
    parser.add_argument(
        "--dest-count",
        type=int,
        default=1,
        help="number of fresh P2WPKH destinations to consolidate into",
    )
    parser.add_argument(
        "--addr-file",
        help="path to a file with one address per line (in addition to args)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable JSON instead of the text report",
    )
    args = parser.parse_args(argv)

    addresses = list(args.addresses)
    if args.addr_file:
        with open(args.addr_file, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    addresses.append(line)

    if not addresses:
        parser.error("supply at least one address (as args or via --addr-file)")

    rows, errors = analyze(
        addresses, args.network, args.sat_vb, args.dest_count
    )

    if args.json:
        exposed = [r for r in rows if r["exposed"]]
        out = {
            "network": args.network,
            "sat_vb": args.sat_vb,
            "dest_count": args.dest_count,
            "utxos": rows,
            "errors": [{"address": a, "error": m} for a, m in errors],
            "totals": {
                "exposed_count": len(exposed),
                "exposed_value": sum(r["value"] for r in exposed),
                "latent_count": len(rows) - len(exposed),
                "latent_value": sum(r["value"] for r in rows if not r["exposed"]),
            },
        }
        print(json.dumps(out, indent=2))
    else:
        print(build_report(
            rows, errors, args.network, args.sat_vb, args.dest_count))

    return 0


if __name__ == "__main__":
    sys.exit(main())
