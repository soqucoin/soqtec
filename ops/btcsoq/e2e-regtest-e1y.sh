#!/usr/bin/env bash
# BTCSOQ e1y proof — expired intents revive when money arrives.
#   Deposit leg: intent expires (TTL=0) → deposit lands anyway → intent
#   revives → receipt mints. Redeem leg: redeem registration expires →
#   receipt returned anyway → registration revives → BTC released.
# Run as root on the Services VPS against the DEV instance (regtest).
# Restores the dev .env on exit.
set -uo pipefail

API=http://127.0.0.1:3005
SIGNER=http://127.0.0.1:8562
RTCLI="sudo -u bitcoin /usr/local/bin/bitcoin-cli -regtest -datadir=/var/lib/bitcoind-regtest"
SOQRPC() { curl -s -u "soqucoin:$SOQ_PASS" --data-binary "{\"method\":\"$1\",\"params\":$2}" http://127.0.0.1:38332/; }
SOQ_PASS=$(grep -oP "^rpcpassword=\K.*" /root/.soqucoin/soqucoin.conf)
SIGNER_TOKEN=$(grep -oP "SOQ_SIGNER_API_TOKEN=\K.*" /var/lib/btcsoq-signer/secrets.env)
REDEMPTION="ssq1p2qnm67hddjyr0f2xd44mn6ltz7wt9ajxryt9eqkjlkvwjstww3es9ycs00"
ATTENDEE="ssq1pt4r45qjhwz88xcjxrpt3rjkwe7fwzjn84n3h78hg7dutm45rqa3qjzxh29"
ENVFILE=/opt/btcsoq-dev/relayer/.env

PASS=0; FAIL=0
check() {
  if [ "$2" = "true" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); echo "  ✗ FAIL: $1"; fi
}
wait_status() { # intent_id status timeout_sec
  local id=$1 want=$2 timeout=$3 t=0 st=""
  while [ $t -lt $timeout ]; do
    st=$(curl -s "$API/api/btc/status/$id" | jq -r '.intent.status // "?"')
    [ "$st" = "$want" ] && return 0
    sleep 5; t=$((t+5))
  done
  echo "    (last status: $st)"
  return 1
}
bsq_tag() { # op(M|R) sats txid vout → payload hex
  python3 - "$1" "$2" "$3" "$4" <<'PYEOF'
import struct, sys
op, sats, txid, vout = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
p = b"BSQ1" + op.encode() + struct.pack("<Q", sats) + bytes.fromhex(txid) + struct.pack("<I", vout)
print(p.hex())
PYEOF
}
restore_env() {
  if [ -f "$ENVFILE.e1y-bak" ]; then
    mv "$ENVFILE.e1y-bak" "$ENVFILE"
    systemctl restart btcsoq-relayer-dev
    echo "  (dev .env restored, relayer restarted)"
  fi
}
trap restore_env EXIT

echo "── 0. Force TTL=0 on the dev instance ────────────────"
cp "$ENVFILE" "$ENVFILE.e1y-bak"
grep -q '^BTCSOQ_INTENT_TTL_HOURS=' "$ENVFILE" \
  && sed -i 's/^BTCSOQ_INTENT_TTL_HOURS=.*/BTCSOQ_INTENT_TTL_HOURS=0/' "$ENVFILE" \
  || echo "BTCSOQ_INTENT_TTL_HOURS=0" >> "$ENVFILE"
systemctl restart btcsoq-relayer-dev
sleep 6
check "dev relayer active" "$([ "$(systemctl is-active btcsoq-relayer-dev)" = active ] && echo true || echo false)"
check "btcsoq-signer active" "$([ "$(systemctl is-active btcsoq-signer)" = active ] && echo true || echo false)"
MINERADDR=$($RTCLI -rpcwallet=miner getnewaddress)

echo "── 1. Deposit intent expires, money revives it ───────"
INTENT=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$ATTENDEE\"}")
ID=$(echo "$INTENT" | jq -r .intentId)
DEPADDR=$(echo "$INTENT" | jq -r .btcDepositAddress)
check "intent created" "$(echo "$INTENT" | jq '.ok')"
if wait_status "$ID" expired 90; then check "intent → expired (TTL 0)" true; else check "intent → expired (TTL 0)" false; fi

TXID=$($RTCLI -rpcwallet=miner sendtoaddress "$DEPADDR" 0.5)
$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null
echo "  deposit to the EXPIRED address: $TXID"
if wait_status "$ID" minted 240; then check "expired intent revived → minted" true; else check "expired intent revived → minted" false; fi

ST=$(curl -s "$API/api/btc/status/$ID")
MINTTXID=$(echo "$ST" | jq -r '.intent.mintTxid // ""')
check "mintTxid recorded" "$([ -n "$MINTTXID" ] && [ "$MINTTXID" != "null" ] && echo true || echo false)"
DEPVOUT=$(curl -s "$API/api/btc/deposits" | jq -r --arg t "$TXID" '.deposits[] | select(.txid==$t) | .vout')
NMINT=$(curl -s "$API/api/btc/mints" | jq --arg k "$TXID:$DEPVOUT" '[.mints[] | select(.key==$k)] | length')
check "exactly ONE mint record (revive stayed CAS-idempotent)" "$([ "$NMINT" = "1" ] && echo true || echo false)"

echo "── 2. Redeem registration expires, receipt revives it ─"
PAYOUT=$($RTCLI -rpcwallet=miner getnewaddress "" bech32)
RINTENT=$(curl -s -X POST "$API/api/btc/redeem-intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$ATTENDEE\",\"btcAddress\":\"$PAYOUT\"}")
RID=$(echo "$RINTENT" | jq -r .intentId)
check "redeem intent created" "$(echo "$RINTENT" | jq '.ok')"
if wait_status "$RID" expired 90; then check "redeem intent → expired (TTL 0)" true; else check "redeem intent → expired (TTL 0)" false; fi

echo "  waiting for the receipt carrier to reach 3 stagenet confs..."
T=0; CONF=0
while [ $T -lt 900 ]; do
  CONF=$(SOQRPC getrawtransaction "[\"$MINTTXID\", true]" | jq -r '.result.confirmations // 0')
  [ "$CONF" -ge 3 ] 2>/dev/null && break
  sleep 15; T=$((T+15))
done
check "carrier confirmed (>=3)" "$([ "$CONF" -ge 3 ] && echo true || echo false)"

RTAG=$(bsq_tag R 50000000 "$TXID" "$DEPVOUT")
# Pin the carrier outpoint (vout[0] of the mint) — the attendee address
# holds coins from past runs, and an unpinned spend picks the wrong one,
# which the gateway then (correctly) holds as unbacked.
SPEND=$(curl -s -X POST -H "Authorization: Bearer $SIGNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"recipient_address\":\"$REDEMPTION\",\"amount\":300000,\"op_return_hex\":\"$RTAG\",\"from_address\":\"$ATTENDEE\",\"fee_rate\":1000,\"utxos\":[\"$MINTTXID:0\"]}" \
  "$SIGNER/api/v1/send-btcsoq-mint")
SPENDTX=$(echo "$SPEND" | jq -r '.txid // ""')
[ -z "$SPENDTX" ] || [ "$SPENDTX" = "null" ] && echo "  signer response: $SPEND"
echo "  receipt spend into redemption (against an EXPIRED registration): $SPENDTX"
check "receipt spend broadcast" "$([ -n "$SPENDTX" ] && [ "$SPENDTX" != "null" ] && echo true || echo false)"
if wait_status "$RID" released 900; then check "expired registration revived → released" true; else check "expired registration revived → released" false; fi

echo ""
echo "══ e1y proof: $PASS passed, $FAIL failed ══"
[ $FAIL -eq 0 ]
