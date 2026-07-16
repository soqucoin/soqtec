#!/usr/bin/env bash
# BTCSOQ Day-4 hardening E2E — circuit breaker + reorg + double-intent +
# coin-controlled redemption (DL §6 Day-4 scope), on the regtest lane (:3005).
# Run as root on the Services VPS.
set -uo pipefail

API=http://127.0.0.1:3005
SIGNER=http://127.0.0.1:8562
RTCLI="sudo -u bitcoin /usr/local/bin/bitcoin-cli -regtest -datadir=/var/lib/bitcoind-regtest"
SOQ_PASS=$(grep -oP "^rpcpassword=\K.*" /root/.soqucoin/soqucoin.conf)
SOQRPC() { curl -s -u "soqucoin:$SOQ_PASS" --data-binary "{\"method\":\"$1\",\"params\":$2}" http://127.0.0.1:38332/; }
SIGNER_TOKEN=$(grep -oP "SOQ_SIGNER_API_TOKEN=\K.*" /var/lib/btcsoq-signer/secrets.env)
ATTENDEE="ssq1pt4r45qjhwz88xcjxrpt3rjkwe7fwzjn84n3h78hg7dutm45rqa3qjzxh29"
REDEMPTION="ssq1p2qnm67hddjyr0f2xd44mn6ltz7wt9ajxryt9eqkjlkvwjstww3es9ycs00"
PAUSE=/opt/btcsoq-dev/data/PAUSE
ENVF=/opt/btcsoq-dev/relayer/.env

PASS=0; FAIL=0
check() { if [ "$2" = "true" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ FAIL: $1"; fi; }
mine() { $RTCLI generatetoaddress "${1:-1}" "$($RTCLI -rpcwallet=miner getnewaddress)" > /dev/null; }
new_deposit() { # ssq amount → echoes "intentId txid depaddr"
  local I=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' -d "{\"ssqAddress\":\"$1\"}")
  local ID=$(echo "$I" | jq -r .intentId) A=$(echo "$I" | jq -r .btcDepositAddress)
  local T=$($RTCLI -rpcwallet=miner sendtoaddress "$A" "$2")
  echo "$ID $T $A"
}
wait_status() { local id=$1 want=$2 t=0; while [ $t -lt "${3:-120}" ]; do
  [ "$(curl -s "$API/api/btc/status/$id" | jq -r '.intent.status // "?"')" = "$want" ] && return 0
  sleep 5; t=$((t+5)); done; return 1; }
intent_status() { curl -s "$API/api/btc/status/$1" | jq -r '.intent.status'; }
set_env() { # KEY VALUE — idempotent env swap + restart
  grep -q "^$1=" "$ENVF" && sed -i "s|^$1=.*|$1=$2|" "$ENVF" || echo "$1=$2" >> "$ENVF"
  systemctl restart btcsoq-relayer-dev; sleep 6
}

echo "── 0. Baseline: unlimited caps (each test flips exactly one control) ─"
set_env BTCSOQ_MAX_DAILY_MINT_SATS 0
set_env BTCSOQ_MAX_DAILY_RELEASE_SATS 0

echo "── 1. Pause switch: money halts, resumes, nothing is lost ─"
rm -f "$PAUSE"
touch "$PAUSE"
B=$(curl -s "$API/api/btc/gateway" | jq '.gateway.breaker.paused')
check "breaker reports paused" "$B"
read PID PTX _ <<< "$(new_deposit "$ATTENDEE" 0.30)"
mine; sleep 40   # confirmed event + at least one money tick while paused
ST=$(intent_status "$PID")
check "intent parked while paused (status=$ST, no mint)" "$([ "$ST" = "confirmed" ] || [ "$ST" = "minting" ] && echo true || echo false)"
MT=$(curl -s "$API/api/btc/status/$PID" | jq -r '.intent.mintTxid // ""')
check "no mintTxid while paused" "$([ -z "$MT" ] && echo true || echo false)"
check "deferral logged" "$(journalctl -u btcsoq-relayer-dev --since '-3min' | grep -q 'deferred.*paused' && echo true || echo false)"
rm -f "$PAUSE"
if wait_status "$PID" minted 360; then check "unpause → minted (deferred work resumed)" true; else check "unpause → minted" false; fi

echo "── 2. Reorg: deposit block invalidated, re-mined — ONE mint ever ─"
read RID RTX _ <<< "$(new_deposit "$ATTENDEE" 0.20)"
BLOCK=$($RTCLI getbestblockhash); mine
if wait_status "$RID" minted 360; then check "minted at 1 conf" true; else check "minted at 1 conf" false; fi
M1=$(curl -s "$API/api/btc/status/$RID" | jq -r '.intent.mintTxid')
TIP=$($RTCLI getbestblockhash)
$RTCLI invalidateblock "$TIP" > /dev/null          # deposit back to mempool
sleep 12                                           # a poll tick during the reorg window
mine 2                                             # re-include on a new chain
sleep 40                                           # confirmed re-emission + tick
RVOUT=$(curl -s "$API/api/btc/deposits" | jq -r --arg t "$RTX" '.deposits[] | select(.txid==$t) | .vout')
N=$(curl -s "$API/api/btc/mints" | jq --arg k "$RTX:$RVOUT" '[.mints[] | select(.key==$k)] | length')
M2=$(curl -s "$API/api/btc/mints" | jq -r --arg k "$RTX:$RVOUT" '.mints[] | select(.key==$k) | .mintTxid')
check "exactly ONE mint record across the reorg" "$([ "$N" = "1" ] && echo true || echo false)"
check "mintTxid unchanged across the reorg" "$([ "$M2" = "$M1" ] && echo true || echo false)"
LIVE=$(curl -s "$API/api/btc/status/$RID" | jq '.intent.liveConfirmations >= 1')
check "deposit re-confirmed on the new chain" "$LIVE"

echo "── 3. Double-intent: same ssq address, two deposits, two receipts ─"
read D1 T1 _ <<< "$(new_deposit "$ATTENDEE" 0.15)"
read D2 T2 _ <<< "$(new_deposit "$ATTENDEE" 0.10)"
mine
OK1=false; OK2=false
wait_status "$D1" minted 420 && OK1=true
wait_status "$D2" minted 420 && OK2=true
check "both intents minted" "$([ $OK1 = true ] && [ $OK2 = true ] && echo true || echo false)"
X1=$(curl -s "$API/api/btc/status/$D1" | jq -r '.intent.mintTxid')
X2=$(curl -s "$API/api/btc/status/$D2" | jq -r '.intent.mintTxid')
check "distinct mint txs per deposit" "$([ -n "$X1" ] && [ "$X1" != "$X2" ] && echo true || echo false)"

echo "── 4. Daily mint cap: over-cap deposit defers, unlimited resumes ─"
set_env BTCSOQ_MAX_DAILY_MINT_SATS 1000   # far below anything
read CID CTX _ <<< "$(new_deposit "$ATTENDEE" 0.05)"
mine; sleep 40
CST=$(intent_status "$CID")
check "over-cap intent parked (status=$CST)" "$([ "$CST" = "confirmed" ] || [ "$CST" = "minting" ] && echo true || echo false)"
check "cap deferral logged for THIS deposit" "$(journalctl -u btcsoq-relayer-dev --no-pager | grep "deferred for ${CTX:0:16}" | grep -q "daily mint cap" && echo true || echo false)"
USED=$(curl -s "$API/api/btc/gateway" | jq '.gateway.breaker.dailyMintUsedSats')
echo "  (24h minted: $USED sats)"
set_env BTCSOQ_MAX_DAILY_MINT_SATS 0      # unlimited
if wait_status "$CID" minted 360; then check "cap lifted → minted" true; else check "cap lifted → minted" false; fi

echo "── 5. Coin-controlled redemption: pin the exact carrier ─"
# Redeem the double-intent D1 receipt by pinning its carrier outpoint —
# no sweep needed even though the attendee address holds many UTXOs.
PAYOUT=$($RTCLI -rpcwallet=miner getnewaddress "" bech32)
RR=$(curl -s -X POST "$API/api/btc/redeem-intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$ATTENDEE\",\"btcAddress\":\"$PAYOUT\"}")
RRID=$(echo "$RR" | jq -r .intentId)
if [ -z "$X1" ] || [ "$X1" = "null" ]; then check "pin test has a carrier (D1 minted)" false; else
echo "  waiting for carrier $X1 to reach 3 stagenet confs..."
T=0; while [ $T -lt 600 ]; do
  C=$(SOQRPC getrawtransaction "[\"$X1\", true]" | jq -r '.result.confirmations // 0')
  [ "$C" -ge 3 ] 2>/dev/null && break; sleep 15; T=$((T+15)); done
V1=$(curl -s "$API/api/btc/deposits" | jq -r --arg t "$T1" '.deposits[] | select(.txid==$t) | .vout')
RTAG=$(python3 -c "
import struct
p = b'BSQ1' + b'R' + struct.pack('<Q', 15000000) + bytes.fromhex('$T1') + struct.pack('<I', $V1)
print(p.hex())")
SPEND=$(curl -s -X POST -H "Authorization: Bearer $SIGNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"recipient_address\":\"$REDEMPTION\",\"amount\":300000,\"op_return_hex\":\"$RTAG\",\"from_address\":\"$ATTENDEE\",\"fee_rate\":1000,\"utxos\":[\"$X1:0\"]}" \
  "$SIGNER/api/v1/send-btcsoq-mint")
SPTX=$(echo "$SPEND" | jq -r '.txid // ""')
[ -z "$SPTX" ] && echo "  signer response: $SPEND"
check "pinned spend broadcast" "$([ -n "$SPTX" ] && [ "$SPTX" != "null" ] && echo true || echo false)"
VIN0=$(SOQRPC getrawtransaction "[\"$SPTX\", true]" | jq -r '.result.vin[0] | .txid + ":" + (.vout|tostring)')
check "vin[0] IS the pinned carrier (no coin-selection lottery)" "$([ "$VIN0" = "$X1:0" ] && echo true || echo false)"
T=0; RST=""
while [ $T -lt 600 ]; do
  RST=$(curl -s "$API/api/btc/mints" | jq -r --arg k "$T1:$V1" '.mints[] | select(.key==$k) | .status')
  [ "$RST" = "redeemed" ] && break; sleep 15; T=$((T+15))
done
RELTX=$(curl -s "$API/api/btc/mints" | jq -r --arg k "$T1:$V1" '.mints[] | select(.key==$k) | .releaseTxid // ""')
check "pinned redemption → record redeemed + BTC released (FIFO intent binding: oldest open intent for the address absorbs it)" "$([ "$RST" = "redeemed" ] && [ -n "$RELTX" ] && echo true || echo false)"
fi

echo "── 6. Pinned-utxo input validation ────────────────────"
RTAG6=$(python3 -c "
import struct
p = b'BSQ1' + b'R' + struct.pack('<Q', 1) + bytes.fromhex('ab'*32) + struct.pack('<I', 0)
print(p.hex())")
BADREQ=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $SIGNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"recipient_address\":\"$REDEMPTION\",\"amount\":300000,\"op_return_hex\":\"$RTAG6\",\"from_address\":\"$ATTENDEE\",\"fee_rate\":1000,\"utxos\":[\"nothex:0\"]}" \
  "$SIGNER/api/v1/send-btcsoq-mint")
check "malformed pinned outpoint → 400" "$([ "$BADREQ" = "400" ] && echo true || echo false)"
UNKNOWN=$(curl -s -X POST -H "Authorization: Bearer $SIGNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"recipient_address\":\"$REDEMPTION\",\"amount\":300000,\"op_return_hex\":\"$RTAG6\",\"from_address\":\"$ATTENDEE\",\"fee_rate\":1000,\"utxos\":[\"$(printf 'cd%.0s' {1..32}):0\"]}" \
  "$SIGNER/api/v1/send-btcsoq-mint")
check "unknown pinned outpoint rejected with an error" "$(echo "$UNKNOWN" | jq 'has("error")')"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  DAY-4 HARDENING: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════════════"
[ $FAIL -eq 0 ]
