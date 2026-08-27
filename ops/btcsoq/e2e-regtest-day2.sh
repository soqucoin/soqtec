#!/usr/bin/env bash
# BTCSOQ Day-2 E2E — the money loop (DL §6 Day-2 exit criterion)
# Proves, on BTC regtest + Soqucoin stagenet:
#   deposit → BTCSOQ receipt minted under the attendee's ML-DSA-44 address
#   (carrier UTXO + BSQ1 OP_RETURN tag, atomically) → receipt redeemed →
#   BTC released — plus the negative tests: replay (one mint per outpoint,
#   across restart), underpay, redeem-without-receipt, signer-down recovery.
#
# Run as root on the Services VPS.
set -uo pipefail

API=http://127.0.0.1:3005
SIGNER=http://127.0.0.1:8562
RTCLI="sudo -u bitcoin /usr/local/bin/bitcoin-cli -regtest -datadir=/var/lib/bitcoind-regtest"
SOQRPC() { curl -s -u "soqucoin:$SOQ_PASS" --data-binary "{\"method\":\"$1\",\"params\":$2}" http://127.0.0.1:38332/; }
SOQ_PASS=$(grep -oP "^rpcpassword=\K.*" /root/.soqucoin/soqucoin.conf)
SIGNER_TOKEN=$(grep -oP "SOQ_SIGNER_API_TOKEN=\K.*" /var/lib/btcsoq-signer/secrets.env)

MINT_FLOAT="ssq1pauqwfd690njxtkjy9ss2kfzv7p29mccvta6m2l2ut7x8dfpku3gqsulwl3"
REDEMPTION="ssq1p2qnm67hddjyr0f2xd44mn6ltz7wt9ajxryt9eqkjlkvwjstww3es9ycs00"
ATTENDEE="ssq1pt4r45qjhwz88xcjxrpt3rjkwe7fwzjn84n3h78hg7dutm45rqa3qjzxh29"

PASS=0; FAIL=0
check() {
  if [ "$2" = "true" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); echo "  ✗ FAIL: $1"; fi
}

# Wait until a stagenet address has a confirmed (>=3 conf) UTXO per the signer.
wait_signer_confirmed() { # min_confirmed_shors timeout_sec
  local want=$1 timeout=$2 t=0
  while [ $t -lt $timeout ]; do
    local bal
    bal=$(curl -s -H "Authorization: Bearer $SIGNER_TOKEN" "$SIGNER/api/v1/balance" | jq -r '.confirmed // 0')
    if [ "$bal" -ge "$want" ] 2>/dev/null; then return 0; fi
    sleep 15; t=$((t+15))
  done
  return 1
}

# Wait until an intent reaches a status (or fail after timeout).
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
  python3 - "$1" "$2" "$3" "$4" <<'EOF'
import struct, sys
op, sats, txid, vout = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
p = b"BSQ1" + op.encode() + struct.pack("<Q", sats) + bytes.fromhex(txid) + struct.pack("<I", vout)
print(p.hex())
EOF
}

echo "── 0. Pre-flight ─────────────────────────────────────"
check "btcsoq-relayer-dev active" "$([ "$(systemctl is-active btcsoq-relayer-dev)" = active ] && echo true || echo false)"
check "btcsoq-signer active" "$([ "$(systemctl is-active btcsoq-signer)" = active ] && echo true || echo false)"
echo "  waiting for mint float (>=100 SOQ confirmed at 3 confs, stagenet blocks)..."
if wait_signer_confirmed 10000000000 900; then check "mint float confirmed" true; else check "mint float confirmed" false; fi

# Release wallet float (regtest BTC)
MINERADDR=$($RTCLI -rpcwallet=miner getnewaddress)
RELADDR=$($RTCLI -rpcwallet=btcsoq-release getnewaddress "float" bech32m)
$RTCLI -rpcwallet=miner sendtoaddress "$RELADDR" 1.0 > /dev/null
$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null
sleep 2
RELBAL=$($RTCLI -rpcwallet=btcsoq-release getbalances | jq '.mine.trusted')
check "release wallet funded (>=1 BTC)" "$(echo "$RELBAL >= 1.0" | bc -l | sed 's/1/true/;s/0/false/')"

echo "── 1. Deposit intent + 0.5 BTC deposit ───────────────"
INTENT=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$ATTENDEE\"}")
ID=$(echo "$INTENT" | jq -r .intentId)
DEPADDR=$(echo "$INTENT" | jq -r .btcDepositAddress)
check "intent created" "$(echo "$INTENT" | jq '.ok')"
TXID=$($RTCLI -rpcwallet=miner sendtoaddress "$DEPADDR" 0.5)
echo "  deposit: $TXID"
$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null

echo "── 2. Receipt MINT (carrier + BSQ1 tag, atomic) ──────"
if wait_status "$ID" minted 120; then check "intent → minted" true; else check "intent → minted" false; fi
ST=$(curl -s "$API/api/btc/status/$ID")
MINTTXID=$(echo "$ST" | jq -r '.intent.mintTxid // ""')
echo "$ST" | jq -c '.intent | {status, sats, mintTxid}'
check "mintTxid recorded" "$([ -n "$MINTTXID" ] && [ "$MINTTXID" != "null" ] && echo true || echo false)"

# Verify the mint tx ON STAGENET: vout[0] carrier → attendee, vout[1] = exact BSQ1 tag
DEPVOUT=$(curl -s "$API/api/btc/deposits" | jq -r --arg t "$TXID" '.deposits[] | select(.txid==$t) | .vout')
WANT_TAG=$(bsq_tag M 50000000 "$TXID" "$DEPVOUT")
MINTTX=$(SOQRPC getrawtransaction "[\"$MINTTXID\", true]")
V0ADDR=$(echo "$MINTTX" | jq -r '.result.vout[0].scriptPubKey.address // .result.vout[0].scriptPubKey.addresses[0]')
V1HEX=$(echo "$MINTTX" | jq -r '.result.vout[1].scriptPubKey.hex')
V0VAL=$(echo "$MINTTX" | jq -r '.result.vout[0].value')
check "carrier vout[0] pays the attendee ssq address" "$([ "$V0ADDR" = "$ATTENDEE" ] && echo true || echo false)"
check "carrier value = 0.2 SOQ" "$(echo "$V0VAL" | jq '. == 0.2')"
check "vout[1] OP_RETURN carries the exact BSQ1 mint tag" "$([ "$V1HEX" = "6a31$WANT_TAG" ] && echo true || echo false)"

GW=$(curl -s "$API/api/btc/gateway")
check "PoR: outstanding receipts = 50,000,000 sats" "$(echo "$GW" | jq '.gateway.receipts.outstandingSats == 50000000')"

echo "── 3. Replay defense (one mint per outpoint, across restart) ─"
systemctl restart btcsoq-relayer-dev
sleep 6
curl -s -X POST "$API/api/btc/block-notify" -H 'Content-Type: application/json' -d '{"hash":"replay-test"}' > /dev/null
sleep 8
MINTS=$(curl -s "$API/api/btc/mints")
NMINT=$(echo "$MINTS" | jq --arg k "$TXID:$DEPVOUT" '[.mints[] | select(.key==$k)] | length')
SAMETX=$(echo "$MINTS" | jq -r --arg k "$TXID:$DEPVOUT" '.mints[] | select(.key==$k) | .mintTxid')
check "exactly ONE mint record for the deposit outpoint" "$([ "$NMINT" = "1" ] && echo true || echo false)"
check "mintTxid unchanged after restart + re-poll" "$([ "$SAMETX" = "$MINTTXID" ] && echo true || echo false)"

echo "── 4. Redemption: receipt → redemption addr → BTC released ─"
PAYOUT=$($RTCLI -rpcwallet=miner getnewaddress "" bech32)
RINTENT=$(curl -s -X POST "$API/api/btc/redeem-intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$ATTENDEE\",\"btcAddress\":\"$PAYOUT\"}")
RID=$(echo "$RINTENT" | jq -r .intentId)
check "redeem intent created" "$(echo "$RINTENT" | jq '.ok')"

echo "  waiting for the receipt carrier to reach 3 stagenet confs..."
T=0; CONF=0
while [ $T -lt 900 ]; do
  CONF=$(SOQRPC getrawtransaction "[\"$MINTTXID\", true]" | jq -r '.result.confirmations // 0')
  [ "$CONF" -ge 3 ] 2>/dev/null && break
  sleep 15; T=$((T+15))
done
check "carrier confirmed (>=3)" "$([ "$CONF" -ge 3 ] && echo true || echo false)"

# Attendee spends the receipt into the redemption address (self-describing
# BSQ1 'R' tag; lineage is proven by the INPUT = the carrier outpoint).
RTAG=$(bsq_tag R 50000000 "$TXID" "$DEPVOUT")
SPEND=$(curl -s -X POST -H "Authorization: Bearer $SIGNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"recipient_address\":\"$REDEMPTION\",\"amount\":300000,\"op_return_hex\":\"$RTAG\",\"from_address\":\"$ATTENDEE\",\"fee_rate\":1000}" \
  "$SIGNER/api/v1/send-btcsoq-mint")
SPENDTX=$(echo "$SPEND" | jq -r '.txid // ""')
[ -z "$SPENDTX" ] || [ "$SPENDTX" = "null" ] && echo "  signer response: $SPEND"
echo "  receipt spend: $SPENDTX"
check "receipt spend broadcast (spends the carrier)" "$([ -n "$SPENDTX" ] && [ "$SPENDTX" != "null" ] && echo true || echo false)"

echo "  waiting for redemption detection + BTC release (needs 1 stagenet block + scan tick)..."
if wait_status "$RID" released 900; then check "redeem intent → released" true; else check "redeem intent → released" false; fi
RST=$(curl -s "$API/api/btc/status/$RID")
RELTXID=$(echo "$RST" | jq -r '.intent.releaseTxid // ""')
echo "$RST" | jq -c '.intent | {status, sats, releaseTxid}'
check "releaseTxid recorded" "$([ -n "$RELTXID" ] && [ "$RELTXID" != "null" ] && echo true || echo false)"

$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null
sleep 2
RELTX=$($RTCLI -rpcwallet=btcsoq-release gettransaction "$RELTXID" 2>/dev/null)
RCOMMENT=$(echo "$RELTX" | jq -r '.comment // ""')
check "release tx in the release wallet, comment=redeem:<intentId>" "$([ "$RCOMMENT" = "redeem:$RID" ] && echo true || echo false)"
GOT=$($RTCLI -rpcwallet=miner listunspent 0 999 "[\"$PAYOUT\"]" | jq '[.[].amount] | add // 0')
check "payout address received ~0.5 BTC (minus network fee)" "$(echo "$GOT" | jq '. > 0.49 and . <= 0.5')"

GW=$(curl -s "$API/api/btc/gateway")
check "PoR: outstanding back to 0, redeemed = 50,000,000" "$(echo "$GW" | jq '.gateway.receipts.outstandingSats == 0 and .gateway.receipts.redeemedSats == 50000000')"

echo "── 5. Underpay: below-minimum deposit is never minted ─"
UI=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$ATTENDEE\"}")
UPID=$(echo "$UI" | jq -r .intentId)
UDEP=$(echo "$UI" | jq -r .btcDepositAddress)
UTX=$($RTCLI -rpcwallet=miner sendtoaddress "$UDEP" 0.00005)
$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null
if wait_status "$UPID" failed 90; then check "underpay intent → failed" true; else check "underpay intent → failed" false; fi
UREASON=$(curl -s "$API/api/btc/status/$UPID" | jq -r '.intent.failReason // ""')
echo "  failReason: $UREASON"
check "failReason mentions underpay" "$(echo "$UREASON" | grep -q underpay && echo true || echo false)"
UVOUT=$(curl -s "$API/api/btc/deposits" | jq -r --arg t "$UTX" '.deposits[] | select(.txid==$t) | .vout')
UNMINT=$(curl -s "$API/api/btc/mints" | jq --arg k "$UTX:$UVOUT" '[.mints[] | select(.key==$k)] | length')
check "NO mint record for the underpay deposit" "$([ "$UNMINT" = "0" ] && echo true || echo false)"

echo "── 6. Redeem-without-receipt: unbacked coins are held ─"
FAKE_TAG=$(bsq_tag R 999 "$(printf 'ab%.0s' {1..32})" 0)
UNBACKED=$(curl -s -X POST -H "Authorization: Bearer $SIGNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"recipient_address\":\"$REDEMPTION\",\"amount\":300000,\"op_return_hex\":\"$FAKE_TAG\",\"from_address\":\"$MINT_FLOAT\",\"fee_rate\":1000}" \
  "$SIGNER/api/v1/send-btcsoq-mint")
UBTX=$(echo "$UNBACKED" | jq -r '.txid // ""')
[ -z "$UBTX" ] || [ "$UBTX" = "null" ] && echo "  signer response: $UNBACKED"
echo "  unbacked payment to redemption addr: $UBTX"
BEFORE_RELEASED=$(curl -s "$API/api/btc/gateway" | jq '.gateway.intents.released')
echo "  waiting one stagenet block + scan tick..."
T=0
while [ $T -lt 600 ]; do
  C=$(SOQRPC getrawtransaction "[\"$UBTX\", true]" | jq -r '.result.confirmations // 0')
  [ "$C" -ge 1 ] 2>/dev/null && break
  sleep 15; T=$((T+15))
done
sleep 40   # one money tick past the block
AFTER_RELEASED=$(curl -s "$API/api/btc/gateway" | jq '.gateway.intents.released')
check "no release fired for unbacked coins" "$([ "$BEFORE_RELEASED" = "$AFTER_RELEASED" ] && echo true || echo false)"
check "unbacked payment logged + held" "$(journalctl -u btcsoq-relayer-dev --since '-15min' | grep -q 'Unbacked payment to redemption address' && echo true || echo false)"

echo "── 7. Signer-down: intent parks in 'minting', recovers ─"
SI=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$ATTENDEE\"}")
SID=$(echo "$SI" | jq -r .intentId)
SDEP=$(echo "$SI" | jq -r .btcDepositAddress)
systemctl stop btcsoq-signer
STX=$($RTCLI -rpcwallet=miner sendtoaddress "$SDEP" 0.25)
$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null
if wait_status "$SID" minting 60; then check "signer down → intent parks in 'minting'" true; else check "signer down → intent parks in 'minting'" false; fi
sleep 35   # one full retry tick while down — must NOT flip to failed
STILL=$(curl -s "$API/api/btc/status/$SID" | jq -r '.intent.status')
check "still 'minting' after a retry tick (no false failure)" "$([ "$STILL" = "minting" ] && echo true || echo false)"
systemctl start btcsoq-signer
echo "  signer back — waiting for the retry tick to mint..."
if wait_status "$SID" minted 180; then check "recovered → minted after signer returns" true; else check "recovered → minted after signer returns" false; fi
SMINT=$(curl -s "$API/api/btc/mints" | jq --arg t "$STX" '[.mints[] | select(.key | startswith($t))] | length')
check "exactly ONE mint record (no double-mint through the outage)" "$([ "$SMINT" = "1" ] && echo true || echo false)"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  DAY-2 MONEY LOOP: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════════════"
[ $FAIL -eq 0 ]
