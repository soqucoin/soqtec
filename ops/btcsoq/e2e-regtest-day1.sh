#!/usr/bin/env bash
# BTCSOQ Day-1 E2E — deposit detection on regtest (DL §6 Day-1 exit criterion)
# Proves: intent → fresh P2TR → mempool detection → blocknotify push →
#         confirmed at policy → SPV proof captured + self-verified → PoR balance.
set -euo pipefail

API=http://127.0.0.1:3005
RTCLI="sudo -u bitcoin /usr/local/bin/bitcoin-cli -regtest -datadir=/var/lib/bitcoind-regtest"
SSQ_TEST_ADDR="ssq1pe2etestqqqqqqqqqqqqqqqqqqqqqqqqq"   # shape-valid stagenet test address (Day-1 scope)
PASS=0; FAIL=0

check() { # label condition-result
  if [ "$2" = "true" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); echo "  ✗ FAIL: $1"; fi
}

echo "── 1. Create deposit intent ──────────────────────────"
INTENT=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$SSQ_TEST_ADDR\"}")
echo "$INTENT" | jq -c .
ID=$(echo "$INTENT" | jq -r .intentId)
DEPADDR=$(echo "$INTENT" | jq -r .btcDepositAddress)
check "intent created, id returned" "$(echo "$INTENT" | jq '.ok and (.intentId|length>10)')"
check "fresh P2TR (bcrt1p...) issued" "$(echo "$INTENT" | jq --arg a "$DEPADDR" '.btcDepositAddress | startswith("bcrt1p")')"

echo "── 2. Second intent gets a DIFFERENT address (no reuse) ──"
INTENT2=$(curl -s -X POST "$API/api/btc/intent" -H 'Content-Type: application/json' \
  -d "{\"ssqAddress\":\"$SSQ_TEST_ADDR\"}")
DEPADDR2=$(echo "$INTENT2" | jq -r .btcDepositAddress)
check "no address reuse across intents" "$([ "$DEPADDR" != "$DEPADDR2" ] && echo true || echo false)"

echo "── 3. Invalid ssq address rejected ───────────────────"
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/btc/intent" \
  -H 'Content-Type: application/json' -d '{"ssqAddress":"bogus"}')
check "400 on malformed ssqAddress" "$([ "$BAD" = "400" ] && echo true || echo false)"

echo "── 4. Send 0.5 BTC (attendee deposit) ────────────────"
TXID=$($RTCLI -rpcwallet=miner sendtoaddress "$DEPADDR" 0.5)
echo "  deposit txid: $TXID"
sleep 8   # poll interval is 5s — allow one tick for mempool detection

ST=$(curl -s "$API/api/btc/status/$ID")
echo "$ST" | jq -c '.intent | {status, sats, confirmations}'
check "mempool detection → status=deposit-seen" "$(echo "$ST" | jq '.intent.status == "deposit-seen"')"
check "sats recorded = 50,000,000" "$(echo "$ST" | jq '.intent.sats == 50000000')"

echo "── 5. Mine 1 block (conf policy = 1) ─────────────────"
MINERADDR=$($RTCLI -rpcwallet=miner getnewaddress)
$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null
sleep 3   # blocknotify → immediate poll; small grace

ST=$(curl -s "$API/api/btc/status/$ID")
echo "$ST" | jq -c '.intent | {status, confirmations, liveConfirmations, spvProofAvailable}'
check "confirmed at policy → status=confirmed" "$(echo "$ST" | jq '.intent.status == "confirmed"')"
check "live confirmations >= 1" "$(echo "$ST" | jq '.intent.liveConfirmations >= 1')"
check "SPV proof captured" "$(echo "$ST" | jq '.intent.spvProofAvailable == true')"

echo "── 6. SPV proof independently re-verified on the node ─"
PROOF=$(curl -s "$API/api/btc/status/$ID?proof=1" | jq -r '.intent.spvProof')
VERIFIED=$($RTCLI verifytxoutproof "$PROOF" | jq -r '.[0]')
check "verifytxoutproof returns the deposit txid" "$([ "$VERIFIED" = "$TXID" ] && echo true || echo false)"

echo "── 7. PoR: vault balance reflects the deposit ────────"
GW=$(curl -s "$API/api/btc/gateway")
echo "$GW" | jq -c '.gateway | {healthy, network, blockHeight, vault, deposits}'
check "gateway healthy" "$(echo "$GW" | jq '.gateway.healthy == true')"
check "vault confirmedSats = 50,000,000" "$(echo "$GW" | jq '.gateway.vault.confirmedSats == "50000000"')"
check "deposit ledger has the deposit" "$(echo "$GW" | jq '.gateway.deposits.total >= 1')"

echo "── 8. Unsolicited deposit (no intent) is recorded, not minted ─"
RAWADDR=$($RTCLI -rpcwallet=btcsoq-deposits getnewaddress "unsolicited-test" bech32m)
$RTCLI -rpcwallet=miner sendtoaddress "$RAWADDR" 0.1 > /dev/null
$RTCLI generatetoaddress 1 "$MINERADDR" > /dev/null
sleep 3
GW=$(curl -s "$API/api/btc/gateway")
check "unsolicited deposit counted separately" "$(echo "$GW" | jq '.gateway.deposits.unsolicited >= 1')"
check "vault now 60,000,000 sats" "$(echo "$GW" | jq '.gateway.vault.confirmedSats == "60000000"')"

echo "── 9. Restart survival (state + cursor persistence) ──"
systemctl restart btcsoq-relayer-dev
sleep 5
ST=$(curl -s "$API/api/btc/status/$ID")
check "intent state survives restart" "$(echo "$ST" | jq '.intent.status == "confirmed"')"
GW=$(curl -s "$API/api/btc/gateway")
check "deposit ledger survives restart" "$(echo "$GW" | jq '.gateway.deposits.total >= 2')"

echo ""
echo "═══════════ E2E RESULT: $PASS passed, $FAIL failed ═══════════"
[ "$FAIL" -eq 0 ]
