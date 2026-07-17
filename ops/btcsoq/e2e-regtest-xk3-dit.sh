#!/usr/bin/env bash
# BTCSOQ xk3 + dit proof (regtest, dev instance).
#   xk3: deposit-level mint eligibility —
#     A. a dust deposit to a fresh address does NOT brick it; the real
#        deposit to the SAME address still mints.
#     B. a SECOND real payout to the SAME (already-minted) address mints
#        again on its own outpoint (the fortress reuse promise).
#   dit: payout-commitment binding —
#     C. an attacker who pre-registers their own payout address for the
#        victim's ssq address does NOT get the BTC; the receipt-return tag
#        commits to the victim's address, so the victim's registration binds.
# Run as root on the Services VPS against the dev instance.
set -uo pipefail

API=http://127.0.0.1:3005
SIGNER=http://127.0.0.1:8562
RTCLI="sudo -u bitcoin /usr/local/bin/bitcoin-cli -regtest -datadir=/var/lib/bitcoind-regtest"
SOQRPC() { curl -s -u "soqucoin:$SOQ_PASS" --data-binary "{\"method\":\"$1\",\"params\":$2}" http://127.0.0.1:38332/; }
SOQ_PASS=$(grep -oP "^rpcpassword=\K.*" /root/.soqucoin/soqucoin.conf)
SIGNER_TOKEN=$(grep -oP "SOQ_SIGNER_API_TOKEN=\K.*" /var/lib/btcsoq-signer/secrets.env)
REDEMPTION="ssq1p2qnm67hddjyr0f2xd44mn6ltz7wt9ajxryt9eqkjlkvwjstww3es9ycs00"
ATTENDEE="ssq1pt4r45qjhwz88xcjxrpt3rjkwe7fwzjn84n3h78hg7dutm45rqa3qjzxh29"

PASS=0; FAIL=0
check() { if [ "$2" = "true" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ FAIL: $1"; fi; }
wait_status() { local id=$1 want=$2 timeout=$3 t=0 st=""; while [ $t -lt $timeout ]; do st=$(curl -s "$API/api/btc/status/$id" | jq -r '.intent.status // "?"'); [ "$st" = "$want" ] && return 0; sleep 5; t=$((t+5)); done; echo "    (last: $st)"; return 1; }
# Outpoint-specific (run-independent — the dev store accumulates prior runs).
dep_vout() { curl -s "$API/api/btc/deposits" | jq -r --arg t "$1" '[.deposits[]|select(.txid==$t)|.vout][0] // ""'; }
# Waits for the mint record at a given txid:vout key; echoes its mintTxid.
wait_mint_key() { local key=$1 timeout=$2 t=0 mt=""; while [ $t -lt $timeout ]; do mt=$(curl -s "$API/api/btc/mints" | jq -r --arg k "$key" '[.mints[]|select(.key==$k)|.mintTxid][0] // ""'); [ -n "$mt" ] && [ "$mt" != "null" ] && { echo "$mt"; return 0; }; sleep 10; t=$((t+10)); done; return 1; }

# Committed redeem tag: BSQ1 R sats txid vout + sha256(payout lowercased)[:20]
rtag_commit() { python3 - "$1" "$2" "$3" "$4" <<'PYEOF'
import struct, sys, hashlib
sats, txid, vout, payout = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), sys.argv[4]
p = b"BSQ1" + b"R" + struct.pack("<Q", sats) + bytes.fromhex(txid) + struct.pack("<I", vout)
commit = hashlib.sha256(payout.strip().lower().encode()).digest()[:20]
print((p + commit).hex())
PYEOF
}

echo "── 0. Pre-flight ─────────────────────────────────────"
check "dev relayer active" "$([ "$(systemctl is-active btcsoq-relayer-dev)" = active ] && echo true || echo false)"
MINER=$($RTCLI -rpcwallet=miner getnewaddress)

echo "── A. Dust does not brick a fortress address (xk3) ───"
INTENT=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' -d "{\"ssqAddress\":\"$ATTENDEE\"}")
ID=$(echo "$INTENT" | jq -r .intentId); DEPADDR=$(echo "$INTENT" | jq -r .btcDepositAddress)
check "intent created" "$(echo "$INTENT" | jq '.ok')"
DUST=$($RTCLI -rpcwallet=miner sendtoaddress "$DEPADDR" 0.000006)   # 600 sats
$RTCLI generatetoaddress 1 "$MINER" >/dev/null; sleep 10
DUSTVOUT=$(curl -s "$API/api/btc/deposits" | jq -r --arg t "$DUST" '.deposits[]|select(.txid==$t)|.vout')
ST=$(curl -s "$API/api/btc/status/$ID" | jq -r '.intent.status')
check "intent NOT failed after dust (status=$ST)" "$([ "$ST" != "failed" ] && echo true || echo false)"
NDUSTMINT=$(curl -s "$API/api/btc/mints" | jq --arg k "$DUST:$DUSTVOUT" '[.mints[]|select(.key==$k)]|length')
check "dust outpoint did NOT mint" "$([ "$NDUSTMINT" = "0" ] && echo true || echo false)"
# The real payout to the SAME address
REAL1=$($RTCLI -rpcwallet=miner sendtoaddress "$DEPADDR" 0.5)
$RTCLI generatetoaddress 1 "$MINER" >/dev/null; sleep 10
R1VOUT=$(dep_vout "$REAL1")
MINT1=$(wait_mint_key "$REAL1:$R1VOUT" 200) && check "real deposit to the dusted address minted" true || check "real deposit to the dusted address minted" false

echo "── B. Second payout to the SAME address mints (xk3) ──"
REAL2=$($RTCLI -rpcwallet=miner sendtoaddress "$DEPADDR" 0.5)
$RTCLI generatetoaddress 1 "$MINER" >/dev/null; sleep 10
R2VOUT=$(dep_vout "$REAL2")
MINT2=$(wait_mint_key "$REAL2:$R2VOUT" 200) && check "payout #2 to the reused address minted on its own outpoint" true || check "payout #2 to the reused address minted on its own outpoint" false
check "payout #1 and #2 are distinct mint records" "$([ -n "$MINT1" ] && [ -n "$MINT2" ] && [ "$MINT1" != "$MINT2" ] && echo true || echo false)"

echo "── C. Front-run defeated by payout commitment (dit) ──"
check "carrier for the real payout resolved" "$([ -n "$MINT1" ] && [ "$MINT1" != "null" ] && echo true || echo false)"
ATTACKER_BTC=$($RTCLI -rpcwallet=miner getnewaddress "" bech32)
VICTIM_BTC=$($RTCLI -rpcwallet=miner getnewaddress "" bech32)
# Attacker registers FIRST (would win under the old oldest-open rule)
AID=$(curl -s -X POST "$API/api/btc/redeem-intent" -H 'Content-Type: application/json' -d "{\"ssqAddress\":\"$ATTENDEE\",\"btcAddress\":\"$ATTACKER_BTC\"}" | jq -r .intentId)
VID=$(curl -s -X POST "$API/api/btc/redeem-intent" -H 'Content-Type: application/json' -d "{\"ssqAddress\":\"$ATTENDEE\",\"btcAddress\":\"$VICTIM_BTC\"}" | jq -r .intentId)
check "attacker registered first, victim second" "$([ -n "$AID" ] && [ -n "$VID" ] && echo true || echo false)"
# Victim controls the receipt: spend it with a tag committing to VICTIM_BTC
echo "  waiting for carrier $MINT1 to reach 3 confs..."
T=0; CONF=0; while [ $T -lt 900 ]; do CONF=$(SOQRPC getrawtransaction "[\"$MINT1\", true]" | jq -r '.result.confirmations // 0'); [ "$CONF" -ge 3 ] 2>/dev/null && break; sleep 15; T=$((T+15)); done
check "carrier confirmed (>=3)" "$([ "$CONF" -ge 3 ] && echo true || echo false)"
RTAG=$(rtag_commit 50000000 "$REAL1" "$R1VOUT" "$VICTIM_BTC")
# fee_rate well above the min-relay floor so the spend is a PAID tx, exempt
# from stagenet's free-relay rate limiter (which the many spends this run
# would otherwise trip: "rate limited free transaction").
SPEND=$(curl -s -X POST -H "Authorization: Bearer $SIGNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"recipient_address\":\"$REDEMPTION\",\"amount\":300000,\"op_return_hex\":\"$RTAG\",\"from_address\":\"$ATTENDEE\",\"fee_rate\":10000,\"utxos\":[\"$MINT1:0\"]}" \
  "$SIGNER/api/v1/send-btcsoq-mint")
SPENDTX=$(echo "$SPEND" | jq -r '.txid // ""')
[ -z "$SPENDTX" ] || [ "$SPENDTX" = "null" ] && echo "  signer: $SPEND"
check "receipt spend broadcast (commits to victim payout)" "$([ -n "$SPENDTX" ] && [ "$SPENDTX" != "null" ] && echo true || echo false)"
if wait_status "$VID" released 900; then check "VICTIM registration → released" true; else check "VICTIM registration → released" false; fi
ASTATUS=$(curl -s "$API/api/btc/status/$AID" | jq -r '.intent.status')
check "ATTACKER registration did NOT release (status=$ASTATUS)" "$([ "$ASTATUS" != "released" ] && echo true || echo false)"
# Prove the BTC actually landed on the victim address
RELTX=$(curl -s "$API/api/btc/status/$VID" | jq -r '.intent.releaseTxid // ""')
PAIDVICTIM=$($RTCLI getrawtransaction "$RELTX" true 2>/dev/null | jq -r --arg a "$VICTIM_BTC" '[.vout[]|select(.scriptPubKey.address==$a)]|length')
PAIDATTACKER=$($RTCLI getrawtransaction "$RELTX" true 2>/dev/null | jq -r --arg a "$ATTACKER_BTC" '[.vout[]|select(.scriptPubKey.address==$a)]|length')
check "release paid the VICTIM address" "$([ "$PAIDVICTIM" -ge 1 ] 2>/dev/null && echo true || echo false)"
check "release did NOT pay the ATTACKER address" "$([ "$PAIDATTACKER" = "0" ] && echo true || echo false)"

echo ""
echo "══ xk3+dit proof: $PASS passed, $FAIL failed ══"
[ $FAIL -eq 0 ]
