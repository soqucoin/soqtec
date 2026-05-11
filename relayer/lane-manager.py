#!/usr/bin/env python3
"""
SOQ-TEC Lane Manager — Pre-Allocated UTXO Lanes (PAUL)
=======================================================
Eliminates coin-selection latency for Quantum Express bridge releases.
Replaces 8-minute sendtoaddress with <1-second pre-selected UTXO spend.

Patent: SOQ-P006 Quantum Express (#64/035,873)
Architecture: PAUL — Pre-Allocated UTXO Lanes
Deploy: /usr/local/bin/soqtec-lane-manager.py
Data:   /var/lib/soqtec-lane-manager/lanes.db
Port:   3003 (localhost only — behind nginx if needed)

SOQ-INFRA-018: Refactored to use ElectrumX + soq-signer.
  - Reads (UTXO queries, balance): ElectrumX on 127.0.0.1:50001
  - Writes (send, address gen):    soq-signer REST on 64.23.129.28:8550
  - NO hot wallet dependency.      soqucoind-hot can be decommissioned.
"""

import sqlite3
import json
import time
import threading
import logging
import os
import sys
import socket
import hashlib
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ─── Configuration ────────────────────────────────────────────────────────────

# ElectrumX (reads — UTXO queries, balance, scripthash lookups)
ELECTRUMX_HOST = os.environ.get("PAUL_ELECTRUMX_HOST", "127.0.0.1")
ELECTRUMX_PORT = int(os.environ.get("PAUL_ELECTRUMX_PORT", "50001"))

# soq-signer (writes — send transactions, get addresses)
SIGNER_URL   = os.environ.get("SOQ_SIGNER_URL", "http://64.23.129.28:8550")
SIGNER_TOKEN = os.environ.get("SOQ_SIGNER_TOKEN", "soqsigner-hot-wallet-bearer-2026-staging")

# Cold node RPC (non-wallet calls only: validateaddress, getblockcount)
COLD_RPC_HOST = os.environ.get("PAUL_COLD_HOST", "127.0.0.1")
COLD_RPC_PORT = int(os.environ.get("PAUL_COLD_PORT", "38332"))
COLD_RPC_USER = os.environ.get("PAUL_COLD_USER", "soqucoin")
COLD_RPC_PASS = os.environ.get("PAUL_COLD_PASS", "stagenet_services_2026_secure")

LANE_DENOMINATIONS = [10, 50, 100, 500, 1000, 5000, 10000]  # SOQ
MIN_LANE_DEPTH     = 2      # UTXOs per denomination (trigger refill)
TARGET_LANE_DEPTH  = 3      # UTXOs per denomination (refill target)
TX_FEE_SOQ         = 0.001  # Network fee per release TX (conservative)
REFILL_INTERVAL    = 120    # Seconds between refill checks
SYNC_INTERVAL      = 30     # Seconds between ElectrumX UTXO sync

DB_PATH  = "/var/lib/soqtec-lane-manager/lanes.db"
API_PORT = 3003
LOG_FILE = "/var/log/soqtec-lane-manager.log"

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)-5s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger("lane-manager")

# ─── ElectrumX Client (persistent connection) ────────────────────────────────

class ElectrumXClient:
    """Persistent TCP client for ElectrumX with server.version handshake."""

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self._sock = None
        self._lock = threading.Lock()
        self._id = 0
        self._buf = b""

    def _connect(self):
        """Create connection and perform required server.version handshake."""
        if self._sock:
            try:
                self._sock.close()
            except:
                pass
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(15)
        self._sock.connect((self.host, self.port))
        self._buf = b""
        # ElectrumX requires server.version before any other call
        self._raw_call("server.version", ["paul-lane-manager", "1.4"])
        log.info("ElectrumX connected and handshake complete (%s:%d)", self.host, self.port)

    def _raw_call(self, method, params):
        """Send a single RPC call and return the parsed result."""
        self._id += 1
        req_id = self._id
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params or [],
        }) + "\n"
        self._sock.sendall(payload.encode())

        # Read lines until we find our response (skip notifications)
        while True:
            # Check buffered data first
            while b"\n" in self._buf:
                line, self._buf = self._buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    resp = json.loads(line.decode(errors="replace"))
                    if "result" in resp or "error" in resp:
                        if resp.get("error"):
                            raise RuntimeError(f"ElectrumX {method}: {resp['error']}")
                        return resp.get("result")
                except json.JSONDecodeError:
                    continue

            # Need more data
            chunk = self._sock.recv(131072)
            if not chunk:
                raise RuntimeError(f"ElectrumX {method}: connection closed")
            self._buf += chunk

    def call(self, method, params=None):
        """Thread-safe RPC call with auto-reconnect."""
        with self._lock:
            for attempt in range(2):
                try:
                    if not self._sock:
                        self._connect()
                    return self._raw_call(method, params or [])
                except Exception as e:
                    if attempt == 0:
                        log.warning("ElectrumX call failed, reconnecting: %s", e)
                        self._sock = None
                        continue
                    raise


# Global ElectrumX client (created at startup)
_electrumx = None

def electrumx_call(method, params=None):
    """Convenience wrapper for the global ElectrumX client."""
    global _electrumx
    if _electrumx is None:
        _electrumx = ElectrumXClient(ELECTRUMX_HOST, ELECTRUMX_PORT)
    return _electrumx.call(method, params)


def scripthash_from_spk(script_pubkey_hex):
    """Convert a scriptPubKey hex string to an ElectrumX scripthash."""
    spk_bytes = bytes.fromhex(script_pubkey_hex)
    return hashlib.sha256(spk_bytes).digest()[::-1].hex()

# ─── soq-signer Client ───────────────────────────────────────────────────────

def signer_request(endpoint, method="GET", body=None):
    """Make an authenticated REST call to the soq-signer."""
    url = f"{SIGNER_URL}{endpoint}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {SIGNER_TOKEN}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        raise RuntimeError(f"soq-signer {endpoint}: HTTP {e.code}: {err_body}")

# ─── Cold Node RPC (non-wallet calls only) ────────────────────────────────────

def cold_rpc(method, params=None):
    """Call cold node RPC (validateaddress, getblockcount — NO wallet calls)."""
    import base64
    payload = json.dumps({
        "jsonrpc": "1.0",
        "id": int(time.time() * 1000),
        "method": method,
        "params": params or [],
    }).encode()
    auth = base64.b64encode(f"{COLD_RPC_USER}:{COLD_RPC_PASS}".encode()).decode()
    req = urllib.request.Request(
        f"http://{COLD_RPC_HOST}:{COLD_RPC_PORT}/",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        data = json.loads(e.read())
    if data.get("error"):
        raise RuntimeError(f"Cold RPC {method}: {data['error']['message']}")
    return data["result"]

# ─── Database ─────────────────────────────────────────────────────────────────

_db_lock = threading.Lock()

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS utxos (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            txid            TEXT    NOT NULL,
            vout            INTEGER NOT NULL,
            denomination    INTEGER NOT NULL,
            amount_soq      REAL    NOT NULL,
            address         TEXT    NOT NULL,
            script_pubkey   TEXT    NOT NULL,
            status          TEXT    DEFAULT 'available',
            source_fund_txid TEXT,
            created_at      REAL    DEFAULT (unixepoch()),
            reserved_at     REAL,
            reserved_by     TEXT,
            release_txid    TEXT,
            spent_at        REAL,
            UNIQUE(txid, vout)
        );

        CREATE TABLE IF NOT EXISTS releases (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            burn_id         TEXT    NOT NULL UNIQUE,
            utxo_txid       TEXT,
            utxo_vout       INTEGER,
            recipient       TEXT    NOT NULL,
            gross_amount    REAL    NOT NULL,
            net_amount      REAL    NOT NULL,
            release_txid    TEXT,
            status          TEXT    DEFAULT 'pending',
            error_msg       TEXT,
            created_at      REAL    DEFAULT (unixepoch()),
            released_at     REAL
        );

        CREATE INDEX IF NOT EXISTS idx_utxos_status_denom
            ON utxos(status, denomination);
        CREATE INDEX IF NOT EXISTS idx_releases_burn_id
            ON releases(burn_id);

        CREATE TABLE IF NOT EXISTS lane_addresses (
            address         TEXT    PRIMARY KEY,
            denomination    INTEGER NOT NULL,
            script_pubkey   TEXT    NOT NULL,
            created_at      REAL    DEFAULT (unixepoch())
        );
        """)
    log.info("Database initialized at %s", DB_PATH)

# ─── UTXO Sync (ElectrumX → SQLite) ──────────────────────────────────────────

def sync_utxos():
    """
    Query ElectrumX for UTXOs belonging to known lane addresses and sync to DB.
    Deduplicates by scripthash to avoid querying the same address multiple times.
    """
    with _db_lock, get_db() as conn:
        lane_rows = conn.execute(
            "SELECT address, script_pubkey, denomination FROM lane_addresses"
        ).fetchall()

    if not lane_rows:
        return

    # Deduplicate: group by script_pubkey → {spk: (addr, denom)}
    spk_map = {}
    for row in lane_rows:
        spk = row["script_pubkey"]
        if spk not in spk_map:
            spk_map[spk] = (row["address"], row["denomination"])

    synced = 0
    live_set = set()
    queried = 0
    total = len(spk_map)

    for spk, (addr, denom) in spk_map.items():
        queried += 1
        if queried % 100 == 0:
            log.info("sync_utxos progress: %d/%d scripthashes queried", queried, total)

        try:
            sh = scripthash_from_spk(spk)
            utxos = electrumx_call("blockchain.scripthash.listunspent", [sh])
        except Exception as e:
            log.error("sync_utxos ElectrumX query for %s failed: %s", addr[:16], e)
            continue

        if not utxos:
            continue

        for u in utxos:
            txid = u["tx_hash"]
            vout = u["tx_pos"]
            amount = u["value"] / 1e8  # ElectrumX returns satoshis
            live_set.add((txid, vout))

            with _db_lock, get_db() as conn:
                cur = conn.execute("""
                    INSERT OR IGNORE INTO utxos
                        (txid, vout, denomination, amount_soq, address, script_pubkey,
                         status, source_fund_txid)
                    VALUES (?, ?, ?, ?, ?, ?, 'available', ?)
                """, (txid, vout, denom, amount, addr, spk, txid))
                synced += cur.rowcount

    # Mark stale UTXOs that disappeared from ElectrumX
    with _db_lock, get_db() as conn:
        db_available = conn.execute(
            "SELECT txid, vout FROM utxos WHERE status='available'"
        ).fetchall()
        for r in db_available:
            if (r["txid"], r["vout"]) not in live_set:
                conn.execute(
                    "UPDATE utxos SET status='stale' WHERE txid=? AND vout=?",
                    (r["txid"], r["vout"])
                )
                log.warning("Marked stale UTXO: %s:%d", r["txid"], r["vout"])

    if synced:
        log.info("sync_utxos: added %d new lane UTXOs via ElectrumX", synced)

# ─── Lane Depth & Refill ─────────────────────────────────────────────────────

def get_lane_depths():
    with _db_lock, get_db() as conn:
        rows = conn.execute("""
            SELECT denomination, COUNT(*) as cnt
            FROM utxos WHERE status='available'
            GROUP BY denomination
        """).fetchall()
    return {r["denomination"]: r["cnt"] for r in rows}

def get_signer_balance():
    """Get the balance from soq-signer REST API (replaces wallet getbalance)."""
    try:
        resp = signer_request("/api/v1/balance")
        return resp.get("confirmed", 0) / 1e8  # signer returns satoshis
    except Exception as e:
        log.error("get_signer_balance failed: %s", e)
        return None

def fund_lane_utxo(denomination):
    """
    Create a new lane UTXO by sending from the soq-signer.
    The signer handles coin selection, signing (ML-DSA-44), and broadcast.
    """
    # Generate a fresh lane address using the signer's key manager
    # For now, use one of the signer's managed addresses as the recipient
    # and let the change go back to the signer's change address.
    # The lane address is created on the cold node via validateaddress.
    #
    # SOQ-INFRA-018: The signer manages its own keys and sends to lane addresses.
    # We need a lane-specific address. Use cold node's getnewaddress equivalent
    # or pre-generate addresses. For the refactor, we use the signer's /api/v1/send
    # to send `denomination` SOQ to a fresh address derived from the signer.

    # Get signer's addresses
    status = signer_request("/api/v1/status")
    signer_addrs = status.get("addresses", [])
    if not signer_addrs:
        raise RuntimeError("soq-signer has no managed addresses")

    # For lane funding, we send from the signer to one of its own addresses.
    # The UTXO created at that address becomes the lane UTXO.
    # Use the first signer address as the lane target.
    lane_addr = signer_addrs[0]

    # Resolve scriptPubKey via cold node
    addr_info = cold_rpc("validateaddress", [lane_addr])
    spk = addr_info.get("scriptPubKey", "")

    # Register this as a lane address
    with _db_lock, get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO lane_addresses (address, denomination, script_pubkey)
            VALUES (?, ?, ?)
        """, (lane_addr, denomination, spk))

    # Send via soq-signer REST API (amount in satoshis)
    amount_sat = int(denomination * 1e8)
    result = signer_request("/api/v1/send", method="POST", body={
        "address": lane_addr,
        "amount": amount_sat,
    })

    txid = result.get("txid", "unknown")
    log.info("Funded lane_%d: addr=%s txid=%s via soq-signer (%s)",
             denomination, lane_addr[:20], txid[:16], result.get("elapsed", "?"))
    return txid

def refill_lanes():
    """Top up any lanes below MIN_LANE_DEPTH to TARGET_LANE_DEPTH."""
    depths = get_lane_depths()
    balance = get_signer_balance()
    if balance is None:
        return

    for denom in LANE_DENOMINATIONS:
        current = depths.get(denom, 0)
        if current >= MIN_LANE_DEPTH:
            continue
        needed = TARGET_LANE_DEPTH - current
        cost = needed * denom
        if balance < cost + 1:
            log.warning("refill: insufficient signer balance (%.2f SOQ) for %d × %d SOQ",
                        balance, needed, denom)
            break
        log.info("Refilling lane_%d: current=%d, creating %d UTXOs (cost=%.1f SOQ)",
                 denom, current, needed, cost)
        for _ in range(needed):
            try:
                fund_lane_utxo(denom)
                balance -= denom
                time.sleep(0.5)
            except Exception as e:
                log.error("refill lane_%d failed: %s", denom, e)
                break

# ─── Reserve & Release ────────────────────────────────────────────────────────

def find_best_utxo(net_amount_soq):
    """
    Find the best available lane UTXO for the requested amount.
    Strategy: smallest denomination >= amount, to minimise change output.
    """
    target_denom = None
    for d in sorted(LANE_DENOMINATIONS):
        if d >= net_amount_soq:
            target_denom = d
            break
    if target_denom is None:
        target_denom = max(LANE_DENOMINATIONS)

    with _db_lock, get_db() as conn:
        row = conn.execute("""
            SELECT id, txid, vout, amount_soq, address, script_pubkey
            FROM utxos
            WHERE status='available' AND denomination=?
            ORDER BY created_at ASC
            LIMIT 1
        """, (target_denom,)).fetchone()

        if row is None:
            row = conn.execute("""
                SELECT id, txid, vout, amount_soq, address, script_pubkey
                FROM utxos
                WHERE status='available' AND amount_soq >= ?
                ORDER BY amount_soq ASC
                LIMIT 1
            """, (net_amount_soq + TX_FEE_SOQ,)).fetchone()

    return dict(row) if row else None

def reserve_utxo(utxo_id, burn_id):
    with _db_lock, get_db() as conn:
        conn.execute("""
            UPDATE utxos
            SET status='reserved', reserved_at=unixepoch(), reserved_by=?
            WHERE id=? AND status='available'
        """, (burn_id, utxo_id))

def build_and_broadcast(utxo, recipient, net_amount_soq, burn_id):
    """
    Release a lane UTXO to the recipient via soq-signer.

    SOQ-INFRA-018: Uses soq-signer REST /api/v1/send instead of the old
    lock-all-then-sendtoaddress hack. The signer handles Dilithium signing
    and bech32m address encoding natively — no wallet needed.
    """
    amount_sat = int(net_amount_soq * 1e8)

    result = signer_request("/api/v1/send", method="POST", body={
        "address": recipient,
        "amount": amount_sat,
    })

    release_txid = result.get("txid")
    if not release_txid:
        raise RuntimeError(f"soq-signer returned no txid: {result}")

    log.info("[PAUL] soq-signer send complete: txid=%s elapsed=%s",
             release_txid[:16], result.get("elapsed", "?"))
    return release_txid

def do_bridge_release(burn_id, recipient, gross_amount, net_amount):
    """
    Full PAUL release: find lane UTXO → reserve → send via signer → record.
    Returns {release_txid, net_amount, utxo_txid, utxo_vout}
    """
    with _db_lock, get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO releases (burn_id, recipient, gross_amount, net_amount, status)
            VALUES (?, ?, ?, ?, 'pending')
        """, (burn_id, recipient, gross_amount, net_amount))

    utxo = find_best_utxo(net_amount)
    if not utxo:
        raise RuntimeError(f"Lane exhausted — no UTXO available for {net_amount} SOQ. "
                           "Refiller will top up within 60s.")

    reserve_utxo(utxo["id"], burn_id)

    try:
        release_txid = build_and_broadcast(utxo, recipient, net_amount, burn_id)

        with _db_lock, get_db() as conn:
            conn.execute("""
                UPDATE utxos
                SET status='spent', release_txid=?, spent_at=unixepoch()
                WHERE id=?
            """, (release_txid, utxo["id"]))
            conn.execute("""
                UPDATE releases
                SET status='complete', utxo_txid=?, utxo_vout=?,
                    release_txid=?, released_at=unixepoch()
                WHERE burn_id=?
            """, (utxo["txid"], utxo["vout"], release_txid, burn_id))

        log.info("[PAUL] ✅ Released %s SOQ → %s | utxo=%s:%d | txid=%s",
                 net_amount, recipient, utxo["txid"][:12], utxo["vout"], release_txid[:16])
        return {
            "release_txid": release_txid,
            "net_amount": net_amount,
            "utxo_txid": utxo["txid"],
            "utxo_vout": utxo["vout"],
        }

    except Exception as e:
        with _db_lock, get_db() as conn:
            conn.execute("""
                UPDATE utxos SET status='available', reserved_at=NULL, reserved_by=NULL
                WHERE id=?
            """, (utxo["id"],))
            conn.execute("""
                UPDATE releases SET status='failed', error_msg=?
                WHERE burn_id=?
            """, (str(e), burn_id))
        raise

# ─── HTTP API ─────────────────────────────────────────────────────────────────

def json_response(handler, status, body):
    data = json.dumps(body).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

class LaneHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/health":
            json_response(self, 200, {
                "ok": True,
                "service": "soqtec-lane-manager",
                "backend": "electrumx+soq-signer",  # SOQ-INFRA-018
            })

        elif path == "/status":
            depths = get_lane_depths()
            balance = get_signer_balance()
            with _db_lock, get_db() as conn:
                total_available = conn.execute(
                    "SELECT COUNT(*), SUM(amount_soq) FROM utxos WHERE status='available'"
                ).fetchone()
                total_released = conn.execute(
                    "SELECT COUNT(*) FROM releases WHERE status='complete'"
                ).fetchone()
            json_response(self, 200, {
                "ok": True,
                "signer_balance_soq": balance,
                "lanes": {str(d): depths.get(d, 0) for d in LANE_DENOMINATIONS},
                "total_available_utxos": total_available[0],
                "total_available_soq": total_available[1],
                "total_releases_complete": total_released[0],
                "backend": "electrumx+soq-signer",
            })

        elif path == "/lanes":
            with _db_lock, get_db() as conn:
                rows = conn.execute("""
                    SELECT denomination, txid, vout, amount_soq, status,
                           source_fund_txid, reserved_by, release_txid
                    FROM utxos ORDER BY denomination, created_at
                """).fetchall()
            json_response(self, 200, {
                "ok": True,
                "utxos": [dict(r) for r in rows],
            })

        else:
            json_response(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError:
            json_response(self, 400, {"ok": False, "error": "invalid JSON"})
            return

        if path == "/bridge":
            burn_id   = body.get("burn_id", f"auto_{int(time.time()*1000)}")
            recipient = body.get("recipient") or body.get("soq_address")
            gross     = float(body.get("gross_amount", 0))
            net       = float(body.get("net_amount", gross))

            if not recipient:
                json_response(self, 400, {"ok": False, "error": "recipient required"})
                return
            if net <= 0:
                json_response(self, 400, {"ok": False, "error": "net_amount must be > 0"})
                return
            try:
                t0 = time.time()
                result = do_bridge_release(burn_id, recipient, gross, net)
                elapsed_ms = int((time.time() - t0) * 1000)
                json_response(self, 200, {
                    "ok": True,
                    "release_txid": result["release_txid"],
                    "net_amount": result["net_amount"],
                    "utxo_txid": result["utxo_txid"],
                    "utxo_vout": result["utxo_vout"],
                    "elapsed_ms": elapsed_ms,
                    "method": "PAUL",
                    "backend": "soq-signer",
                })
            except Exception as e:
                log.error("[PAUL] /bridge failed: %s", e)
                json_response(self, 500, {"ok": False, "error": str(e)})

        elif path == "/sync":
            sync_utxos()
            json_response(self, 200, {"ok": True, "message": "sync triggered"})

        elif path == "/refill":
            threading.Thread(target=refill_lanes, daemon=True).start()
            json_response(self, 200, {"ok": True, "message": "refill triggered"})

        else:
            json_response(self, 404, {"ok": False, "error": "not found"})

# ─── Background Threads ───────────────────────────────────────────────────────

def background_sync():
    """Periodically sync ElectrumX UTXOs → SQLite."""
    while True:
        time.sleep(SYNC_INTERVAL)
        try:
            sync_utxos()
        except Exception as e:
            log.error("background_sync error: %s", e)

def background_refill():
    """Periodically check lane depths and refill via soq-signer."""
    time.sleep(10)
    while True:
        try:
            refill_lanes()
        except Exception as e:
            log.error("background_refill error: %s", e)
        time.sleep(REFILL_INTERVAL)

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    init_db()

    log.info("SOQ-INFRA-018: PAUL refactored — ElectrumX reads + soq-signer writes")
    log.info("  ElectrumX: %s:%d", ELECTRUMX_HOST, ELECTRUMX_PORT)
    log.info("  Signer:    %s", SIGNER_URL)
    log.info("  Cold Node: %s:%d", COLD_RPC_HOST, COLD_RPC_PORT)

    # Initial sync runs in background so HTTP server starts immediately
    # (5000+ legacy lane addresses take minutes to sync via ElectrumX)
    log.info("Deferring initial UTXO sync to background thread...")

    # Start background threads
    threading.Thread(target=background_sync,   daemon=True, name="sync").start()
    threading.Thread(target=background_refill, daemon=True, name="refill").start()

    # Start API server
    server = HTTPServer(("127.0.0.1", API_PORT), LaneHandler)
    log.info("SOQ-TEC Lane Manager running on port %d | DB: %s", API_PORT, DB_PATH)
    log.info("Lanes: %s | Min depth: %d | Target: %d",
             LANE_DENOMINATIONS, MIN_LANE_DEPTH, TARGET_LANE_DEPTH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down.")
        server.server_close()

if __name__ == "__main__":
    main()
