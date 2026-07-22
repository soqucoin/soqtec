#!/bin/bash
# Run the BTCSOQ automated consensus-native lifecycle loop (the isolated
# regtest marquee) and serve its live status JSON for the proof page.
#
# The loop is the `btcsoq_demo_loop_tests` case in the test binary, gated on
# BTCSOQ_DEMO_LOOP. It runs the REAL ConnectBlock engine on an isolated regtest
# chain — nothing here touches the live overlay pilot or the demo stagenet.
#
# Usage:
#   ./run-consensus-demo-loop.sh <path-to-test_soqucoin> [serve-dir]
# e.g. on the build VPS:
#   ./run-consensus-demo-loop.sh /root/soqucoin-build/src/test/test_soqucoin /var/www/btcsoq
#
# Env passthrough (see the test for defaults):
#   BTCSOQ_DEMO_ITERS (default 10000 here = effectively endless),
#   BTCSOQ_DEMO_SLEEP (seconds between ops, default 4 for a watchable cadence),
#   BTCSOQ_DEMO_FLOAT (standing float target, default 5).
# Stop cleanly: `touch <serve-dir>/btcsoq-demo-STOP`.
set -euo pipefail

BIN="${1:?usage: run-consensus-demo-loop.sh <test_soqucoin> [serve-dir]}"
SERVE_DIR="${2:-/tmp/btcsoq-demo}"
mkdir -p "$SERVE_DIR"
cp "$(dirname "$0")/btcsoq-consensus-demo.html" "$SERVE_DIR/index.html" 2>/dev/null || true

export BTCSOQ_DEMO_LOOP=1
export BTCSOQ_DEMO_ITERS="${BTCSOQ_DEMO_ITERS:-10000}"
export BTCSOQ_DEMO_SLEEP="${BTCSOQ_DEMO_SLEEP:-4}"
export BTCSOQ_DEMO_FLOAT="${BTCSOQ_DEMO_FLOAT:-5}"
export BTCSOQ_DEMO_STATUS="$SERVE_DIR/btcsoq-demo-status.json"
export BTCSOQ_DEMO_STOP="$SERVE_DIR/btcsoq-demo-STOP"
rm -f "$BTCSOQ_DEMO_STOP"

echo "loop  -> $BIN (iters=$BTCSOQ_DEMO_ITERS sleep=${BTCSOQ_DEMO_SLEEP}s float=$BTCSOQ_DEMO_FLOAT)"
echo "status-> $BTCSOQ_DEMO_STATUS"
echo "page  -> $SERVE_DIR/index.html (serve $SERVE_DIR over HTTP; page fetches ./btcsoq-demo-status.json)"
echo "stop  -> touch $BTCSOQ_DEMO_STOP"

exec "$BIN" --run_test=btcsoq_demo_loop_tests --log_level=message
