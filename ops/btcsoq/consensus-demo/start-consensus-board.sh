#!/bin/bash
# ONE command. Starts the consensus board and prints ONE url to open.
#
#   ./start-consensus-board.sh
#
# That's it. It finds the node binary, runs the isolated consensus loop, serves
# the board + its live data from one place, and tells you what to open. Press
# Ctrl-C to stop everything cleanly. No arguments, no config, no gotchas.
#
# Override only if you want to: BIN=/path/to/test_soqucoin  PORT=8080  ./start-consensus-board.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8080}"
DIR="$HERE/.live"

# 1. Find the node test binary (or take BIN=...).
BIN="${BIN:-}"
if [ -z "$BIN" ]; then
  for c in \
    "/root/soqucoin-build/src/test/test_soqucoin" \
    "$HOME/soqucoin-build/src/test/test_soqucoin" \
    "./src/test/test_soqucoin"; do
    [ -x "$c" ] && BIN="$c" && break
  done
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "Could not find the node binary (test_soqucoin)."
  echo "Build it once, then set BIN=/path/to/test_soqucoin and re-run. Nothing else to do."
  exit 1
fi

# 2. Fresh serve dir with the board page in it.
rm -rf "$DIR"; mkdir -p "$DIR"
cp "$HERE/btcsoq-consensus-demo.html" "$DIR/index.html"
STATUS="$DIR/btcsoq-demo-status.json"
STOP="$DIR/btcsoq-demo-STOP"

# 3. Clean shutdown of both children on Ctrl-C.
LOOP_PID=""; SRV_PID=""
cleanup(){ echo; echo "stopping..."; touch "$STOP" 2>/dev/null || true;
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true;
  [ -n "$LOOP_PID" ] && kill "$LOOP_PID" 2>/dev/null || true; exit 0; }
trap cleanup INT TERM

# 4. Start the consensus loop (isolated regtest; watchable cadence + standing float).
BTCSOQ_DEMO_LOOP=1 BTCSOQ_DEMO_ITERS=100000 BTCSOQ_DEMO_SLEEP="${SLEEP:-4}" \
  BTCSOQ_DEMO_FLOAT="${FLOAT:-5}" BTCSOQ_DEMO_STATUS="$STATUS" BTCSOQ_DEMO_STOP="$STOP" \
  BTCSOQ_DEMO_REQUEST="$DIR/request.txt" \
  "$BIN" --run_test=btcsoq_demo_loop_tests --log_level=message >"$DIR/loop.log" 2>&1 &
LOOP_PID=$!

# 5. Serve the board + its data from one origin (no relayer, no mixed content).
( cd "$DIR" && python3 -m http.server "$PORT" >/dev/null 2>&1 ) &
SRV_PID=$!

# hostname -I is Linux-only; ipconfig covers macOS. Never fatal under set -e.
IP="$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || true) | awk '{print $1}')"
echo "============================================================"
echo "  BTCSOQ consensus board is starting."
echo
echo "  OPEN THIS, then press F11 for fullscreen:"
echo "      http://localhost:$PORT"
[ -n "$IP" ] && echo "      (from another machine on the network: http://$IP:$PORT )"
echo
echo "  The board goes live in about a minute while the node warms up"
echo "  (it shows 'waiting for the node...' until then). Leave this running."
echo "  Press Ctrl-C here to stop everything."
echo
echo "  Skeptic wants their own deposit? After they send testnet4 coins to a"
echo "  boundary address, run in another terminal:"
echo "      echo '<btc_txid> <vout> <sats>' > $DIR/request.txt"
echo "  and the next cycle mints bound to their real deposit."
echo "============================================================"

wait "$LOOP_PID"
