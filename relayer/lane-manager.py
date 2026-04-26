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
"""

import sqlite3
import json
import time
import threading
import logging
import os
import sys
import hmac
import hashlib
import urllib.request
import urllib.error
import base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ─── Configuration ────────────────────────────────────────────────────────────

HOT_RPC_HOST    = "127.0.0.1"
HOT_RPC_PORT    = 44557
HOT_RPC_USER    = "soqucoin_hot"
HOT_RPC_PASS    = "hot_wallet_ops_2026_secure"

LANE_DENOMINATIONS = [10, 50, 100, 500, 1000, 5000, 10000]  # SOQ
MIN_LANE_DEPTH     = 5      # UTXOs per denomination (trigger refill)
TARGET_LANE_DEPTH  = 10     # UTXOs per denomination (refill target)
TX_FEE_SOQ         = 0.001  # Network fee per release TX (conservative)
DUST_SOQ           = 0.001  # Minimum change output to bother creating
REFILL_INTERVAL    = 60     # Seconds between refill checks
SYNC_INTERVAL      = 30     # Seconds between listunspent sync

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

# ─── RPC Helper ───────────────────────────────────────────────────────────────

def rpc(method, params=None):
    """Call soqucoind hot wallet RPC. Returns result or raises on error."""
    payload = json.dumps({
        "jsonrpc": "1.0",
        "id": int(time.time() * 1000),
        "method": method,
        "params": params or [],
    }).encode()
    auth = base64.b64encode(f"{HOT_RPC_USER}:{HOT_RPC_PASS}".encode()).decode()
    req = urllib.request.Request(
        f"http://{HOT_RPC_HOST}:{HOT_RPC_PORT}/",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        data = json.loads(e.read())
    if data.get("error"):
        raise RuntimeError(f"RPC {method} error: {data['error']['message']}")
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
            denomination    INTEGER NOT NULL,  -- SOQ whole number
            amount_soq      REAL    NOT NULL,  -- exact amount
            address         TEXT    NOT NULL,
            script_pubkey   TEXT    NOT NULL,
            status          TEXT    DEFAULT 'available',
            -- 'available', 'reserved', 'spent', 'stale'
            source_fund_txid TEXT,             -- PoR: hot wallet TX that created this UTXO
            created_at      REAL    DEFAULT (unixepoch()),
            reserved_at     REAL,
            reserved_by     TEXT,              -- burn_id / identifier
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
            -- 'pending', 'complete', 'failed'
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

# ─── UTXO Sync (listunspent → SQLite) ────────────────────────────────────────

def sync_utxos():
    """
    Scan hot wallet's listunspent for lane UTXOs and sync into DB.
    Lane UTXOs are identified by matching their address against the
    lane_addresses table (Soqucoin's Dogecoin-derived wallet does NOT
    include labels in listunspent output, so label-based detection fails).
    """
    try:
        unspent = rpc("listunspent", [0, 9999999])  # Include 0-conf for faster pickup
    except Exception as e:
        log.error("sync_utxos listunspent failed: %s", e)
        return

    synced = 0
    with _db_lock, get_db() as conn:
        # Load known lane addresses — match by scriptPubKey because
        # Soqucoin's listunspent returns truncated legacy 'address' for
        # Dilithium bech32m UTXOs (e.g., '3QJmnh' instead of 'sq1p...')
        lane_spk_rows = conn.execute(
            "SELECT script_pubkey, denomination FROM lane_addresses"
        ).fetchall()
        lane_spk_map = {r["script_pubkey"]: r["denomination"] for r in lane_spk_rows}

        for u in unspent:
            spk = u.get("scriptPubKey", "")
            if spk not in lane_spk_map:
                continue
            denom = lane_spk_map[spk]
            amount = float(u["amount"])
            cur = conn.execute("""
                INSERT OR IGNORE INTO utxos
                    (txid, vout, denomination, amount_soq, address, script_pubkey,
                     status, source_fund_txid)
                VALUES (?, ?, ?, ?, ?, ?, 'available', ?)
            """, (
                u["txid"], u["vout"], denom, amount,
                u.get("address", ""), spk,
                u["txid"],
            ))
            synced += cur.rowcount

        # Mark as 'stale' any UTXOs in DB that are no longer in listunspent
        live_set = {(u["txid"], u["vout"]) for u in unspent
                    if u.get("scriptPubKey", "") in lane_spk_map}
        db_available = conn.execute(
            "SELECT txid, vout FROM utxos WHERE status='available'"
        ).fetchall()
        for row in db_available:
            if (row["txid"], row["vout"]) not in live_set:
                conn.execute(
                    "UPDATE utxos SET status='stale' WHERE txid=? AND vout=?",
                    (row["txid"], row["vout"])
                )
                log.warning("Marked stale UTXO: %s:%d", row["txid"], row["vout"])

    if synced:
        log.info("sync_utxos: added %d new lane UTXOs", synced)

# ─── Lane Depth & Refill ─────────────────────────────────────────────────────

def get_lane_depths():
    with _db_lock, get_db() as conn:
        rows = conn.execute("""
            SELECT denomination, COUNT(*) as cnt
            FROM utxos WHERE status='available'
            GROUP BY denomination
        """).fetchall()
    return {r["denomination"]: r["cnt"] for r in rows}

def fund_lane_utxo(denomination: int):
    """
    Create a new lane UTXO of the given denomination from the hot wallet.
    Records the address in lane_addresses so sync_utxos() can identify it.
    """
    label = f"lane_{denomination}"
    addr = rpc("getnewaddress", [label])
    # Register this address as a lane address in the DB
    # Resolve scriptPubKey via validateaddress (needed because listunspent
    # returns truncated addresses for Dilithium bech32m)
    addr_info = rpc("validateaddress", [addr])
    spk = addr_info.get("scriptPubKey", "")
    with _db_lock, get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO lane_addresses (address, denomination, script_pubkey)
            VALUES (?, ?, ?)
        """, (addr, denomination, spk))
    txid = rpc("sendtoaddress", [addr, denomination, f"Lane fund {denomination} SOQ", "", False])
    log.info("Funded lane_%d: addr=%s txid=%s", denomination, addr, txid[:16])
    return txid

def refill_lanes():
    """Top up any lanes below MIN_LANE_DEPTH to TARGET_LANE_DEPTH."""
    depths = get_lane_depths()
    try:
        balance = rpc("getbalance")
    except Exception as e:
        log.error("refill_lanes: can't get balance: %s", e)
        return

    for denom in LANE_DENOMINATIONS:
        current = depths.get(denom, 0)
        if current >= MIN_LANE_DEPTH:
            continue
        needed = TARGET_LANE_DEPTH - current
        cost = needed * denom
        if balance < cost + 1:  # keep 1 SOQ buffer
            log.warning("refill: insufficient balance (%.2f SOQ) to fund %d × %d SOQ lanes",
                        balance, needed, denom)
            break
        log.info("Refilling lane_%d: current=%d, creating %d UTXOs (cost=%.1f SOQ)",
                 denom, current, needed, cost)
        for _ in range(needed):
            try:
                fund_lane_utxo(denom)
                balance -= denom
                time.sleep(0.5)  # Don't spam mempool
            except Exception as e:
                log.error("refill lane_%d failed: %s", denom, e)
                break

# ─── Reserve & Release ────────────────────────────────────────────────────────

def find_best_utxo(net_amount_soq: float):
    """
    Find the best available lane UTXO for the requested amount.
    Strategy: smallest denomination >= amount, to minimise change output.
    Falls back to largest available denomination if none are >= amount (rare).
    """
    target_denom = None
    for d in sorted(LANE_DENOMINATIONS):
        if d >= net_amount_soq:
            target_denom = d
            break
    if target_denom is None:
        # Amount exceeds largest lane — use largest available and issue change
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
            # Fallback: try any denomination with enough funds
            row = conn.execute("""
                SELECT id, txid, vout, amount_soq, address, script_pubkey
                FROM utxos
                WHERE status='available' AND amount_soq >= ?
                ORDER BY amount_soq ASC
                LIMIT 1
            """, (net_amount_soq + TX_FEE_SOQ,)).fetchone()

    return dict(row) if row else None

def reserve_utxo(utxo_id: int, burn_id: str):
    with _db_lock, get_db() as conn:
        conn.execute("""
            UPDATE utxos
            SET status='reserved', reserved_at=unixepoch(), reserved_by=?
            WHERE id=? AND status='available'
        """, (burn_id, utxo_id))

def build_and_broadcast(utxo: dict, recipient: str, net_amount_soq: float, burn_id: str):
    """
    Release a lane UTXO to the recipient.

    Strategy: Soqucoin's createrawtransaction rejects Dilithium bech32m addresses.
    Workaround: lock ALL wallet UTXOs except the target lane UTXO, then use
    sendtoaddress (which DOES accept bech32m), then unlock all.
    This forces the coin selector to use ONLY our pre-selected lane UTXO.
    """
    target_txid = utxo["txid"]
    target_vout = utxo["vout"]

    # 1. Get all unspent UTXOs
    all_utxos = rpc("listunspent", [0, 9999999])

    # 2. Lock everything EXCEPT the target lane UTXO
    to_lock = [{"txid": u["txid"], "vout": u["vout"]}
               for u in all_utxos
               if not (u["txid"] == target_txid and u["vout"] == target_vout)]
    if to_lock:
        rpc("lockunspent", [False, to_lock])

    try:
        # 3. sendtoaddress — now coin selector can ONLY pick the lane UTXO
        release_txid = rpc("sendtoaddress", [
            recipient,
            round(net_amount_soq, 8),
            f"PAUL bridge release: {burn_id[:32]}",
            "",       # comment_to
            False,    # subtractfeefromamount
        ])
    finally:
        # 4. Always unlock everything (even on failure)
        rpc("lockunspent", [True])

    return release_txid

def do_bridge_release(burn_id: str, recipient: str, gross_amount: float, net_amount: float):
    """
    Full PAUL release: find lane UTXO → reserve → build TX → broadcast.
    Returns {release_txid, net_amount, utxo_txid, utxo_vout}
    """
    # Log the release attempt
    with _db_lock, get_db() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO releases (burn_id, recipient, gross_amount, net_amount, status)
            VALUES (?, ?, ?, ?, 'pending')
        """, (burn_id, recipient, gross_amount, net_amount))

    # Find best UTXO
    utxo = find_best_utxo(net_amount)
    if not utxo:
        raise RuntimeError(f"Lane exhausted — no UTXO available for {net_amount} SOQ. "
                           "Refiller will top up within 60s.")

    # Reserve it
    reserve_utxo(utxo["id"], burn_id)

    try:
        # Build and broadcast
        release_txid = build_and_broadcast(utxo, recipient, net_amount, burn_id)

        # Mark as spent
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
        # Release the reservation so it can be retried
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
        pass  # Suppress default HTTP logging (we use our own)

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/health":
            json_response(self, 200, {"ok": True, "service": "soqtec-lane-manager"})

        elif path == "/status":
            depths = get_lane_depths()
            try:
                balance = rpc("getbalance")
            except Exception:
                balance = None
            with _db_lock, get_db() as conn:
                total_available = conn.execute(
                    "SELECT COUNT(*), SUM(amount_soq) FROM utxos WHERE status='available'"
                ).fetchone()
                total_released = conn.execute(
                    "SELECT COUNT(*) FROM releases WHERE status='complete'"
                ).fetchone()
            json_response(self, 200, {
                "ok": True,
                "hot_wallet_soq": balance,
                "lanes": {str(d): depths.get(d, 0) for d in LANE_DENOMINATIONS},
                "total_available_utxos": total_available[0],
                "total_available_soq": total_available[1],
                "total_releases_complete": total_released[0],
            })

        elif path == "/lanes":
            # Proof-of-Reserves: full UTXO list with source txids
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
            # Combined reserve + release — the primary entry point for the relayer
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
    """Periodically sync listunspent → SQLite."""
    while True:
        time.sleep(SYNC_INTERVAL)
        try:
            sync_utxos()
        except Exception as e:
            log.error("background_sync error: %s", e)

def background_refill():
    """Periodically check lane depths and refill if needed."""
    time.sleep(10)  # Give sync time to populate DB first
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

    # Initial sync
    log.info("Starting initial UTXO sync...")
    sync_utxos()
    depths = get_lane_depths()
    log.info("Lane depths on startup: %s", depths)

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
