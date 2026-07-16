#!/usr/bin/env bash
# BTCSOQ Gateway — Day 1: Bitcoin Core on Services VPS (143.110.229.69)
# Plan: soqucoin-ops/design-log/DL-BTC-SOQTEC-GATEWAY-2026-07-16.md (Gate 3 approved)
# Installs Bitcoin Core (GPG-verified), runs testnet4 + regtest daemons,
# creates descriptor wallets: btcsoq-vault-keys (keyed, deposit key custody),
# btcsoq-deposits (watch-only, active tr() descriptors), btcsoq-release (keyed).
# Idempotent: safe to re-run.
set -euo pipefail

VERSION="29.4"
TARBALL="bitcoin-${VERSION}-x86_64-linux-gnu.tar.gz"
BASEURL="https://bitcoincore.org/bin/bitcoin-core-${VERSION}"
WORKDIR="/tmp/btcsoq-install"
T4_DATADIR="/var/lib/bitcoind"
RT_DATADIR="/var/lib/bitcoind-regtest"
CRED_FILE="/root/.btcsoq-rpc.env"   # RPC creds for the relayer .env (never committed)

log() { echo "[btcsoq-setup] $(date -u +%H:%M:%S) $*"; }

# ── 1. Install Bitcoin Core (skip if correct version present) ──────────────
if /usr/local/bin/bitcoind -version 2>/dev/null | grep -q "v${VERSION}"; then
  log "bitcoind v${VERSION} already installed — skipping download"
else
  mkdir -p "$WORKDIR" && cd "$WORKDIR"
  log "Downloading Bitcoin Core ${VERSION}..."
  curl -fsSLO "${BASEURL}/${TARBALL}"
  curl -fsSLO "${BASEURL}/SHA256SUMS"
  curl -fsSLO "${BASEURL}/SHA256SUMS.asc"

  log "Importing builder keys (guix.sigs) + verifying signatures..."
  for key in fanquake achow101 glozow; do
    curl -fsSL "https://raw.githubusercontent.com/bitcoin-core/guix.sigs/main/builder-keys/${key}.gpg" \
      | gpg --import 2>&1 | tail -1 || log "WARN: key import failed for ${key}"
  done
  GOODSIGS=$(gpg --verify SHA256SUMS.asc SHA256SUMS 2>&1 | grep -c "Good signature" || true)
  if [ "$GOODSIGS" -lt 1 ]; then
    log "FATAL: no good GPG signature on SHA256SUMS — aborting"
    exit 1
  fi
  log "GPG: ${GOODSIGS} good signature(s) on SHA256SUMS"

  sha256sum --check --ignore-missing SHA256SUMS
  log "SHA256 verified — installing"
  tar -xzf "$TARBALL"
  install -m 0755 "bitcoin-${VERSION}/bin/bitcoind" "bitcoin-${VERSION}/bin/bitcoin-cli" /usr/local/bin/
  log "Installed: $(/usr/local/bin/bitcoind -version | head -1)"
fi

# ── 2. User + datadirs ──────────────────────────────────────────────────────
id -u bitcoin >/dev/null 2>&1 || useradd -r -m -d /home/bitcoin -s /usr/sbin/nologin bitcoin
mkdir -p "$T4_DATADIR" "$RT_DATADIR"

# ── 3. RPC credentials (generate once, persist in root-only env file) ──────
if [ ! -f "$CRED_FILE" ]; then
  T4_PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  RT_PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  cat > "$CRED_FILE" <<EOF
BTC_T4_RPC_USER=btcsoq
BTC_T4_RPC_PASS=${T4_PASS}
BTC_RT_RPC_USER=btcsoq
BTC_RT_RPC_PASS=${RT_PASS}
EOF
  chmod 600 "$CRED_FILE"
  log "Generated RPC credentials → ${CRED_FILE}"
fi
# shellcheck disable=SC1090
source "$CRED_FILE"

rpcauth_line() {  # user pass -> rpcauth=user:salt$hmac
  python3 - "$1" "$2" <<'PYEOF'
import sys, os, hmac, hashlib
user, pw = sys.argv[1], sys.argv[2]
salt = os.urandom(16).hex()
h = hmac.new(salt.encode(), pw.encode(), hashlib.sha256).hexdigest()
print(f"rpcauth={user}:{salt}${h}")
PYEOF
}

# ── 4. Configs (regenerated each run from persisted creds) ─────────────────
T4_AUTH=$(rpcauth_line "$BTC_T4_RPC_USER" "$BTC_T4_RPC_PASS")
RT_AUTH=$(rpcauth_line "$BTC_RT_RPC_USER" "$BTC_RT_RPC_PASS")

cat > "${T4_DATADIR}/bitcoin.conf" <<EOF
# BTCSOQ gateway — testnet4 node (DL-BTC-SOQTEC-GATEWAY-2026-07-16)
server=1
txindex=1
[testnet4]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=48332
${T4_AUTH}
zmqpubhashblock=tcp://127.0.0.1:28334
zmqpubrawtx=tcp://127.0.0.1:28335
blocknotify=curl -s -m 5 -X POST http://127.0.0.1:3005/api/btc/block-notify -H 'Content-Type: application/json' -d '{"network":"testnet4","hash":"%s"}' || true
EOF

cat > "${RT_DATADIR}/bitcoin.conf" <<EOF
# BTCSOQ gateway — regtest node (demo fallback + E2E)
server=1
txindex=1
[regtest]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=18443
${RT_AUTH}
zmqpubhashblock=tcp://127.0.0.1:28444
zmqpubrawtx=tcp://127.0.0.1:28445
fallbackfee=0.0001
blocknotify=curl -s -m 5 -X POST http://127.0.0.1:3005/api/btc/block-notify -H 'Content-Type: application/json' -d '{"network":"regtest","hash":"%s"}' || true
EOF

chown -R bitcoin:bitcoin "$T4_DATADIR" "$RT_DATADIR"

# ── 5. systemd units ────────────────────────────────────────────────────────
cat > /etc/systemd/system/bitcoind-testnet4.service <<EOF
[Unit]
Description=Bitcoin Core testnet4 (BTCSOQ gateway)
After=network-online.target
Wants=network-online.target

[Service]
User=bitcoin
Group=bitcoin
Type=simple
ExecStart=/usr/local/bin/bitcoind -testnet4 -datadir=${T4_DATADIR} -conf=${T4_DATADIR}/bitcoin.conf
Restart=on-failure
RestartSec=15
TimeoutStopSec=600
MemoryDenyWriteExecute=false

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/bitcoind-regtest.service <<EOF
[Unit]
Description=Bitcoin Core regtest (BTCSOQ gateway demo fallback)
After=network-online.target

[Service]
User=bitcoin
Group=bitcoin
Type=simple
ExecStart=/usr/local/bin/bitcoind -regtest -datadir=${RT_DATADIR} -conf=${RT_DATADIR}/bitcoin.conf
Restart=on-failure
RestartSec=10
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now bitcoind-testnet4.service bitcoind-regtest.service
log "Daemons started (testnet4 IBD begins now)"

T4CLI="sudo -u bitcoin /usr/local/bin/bitcoin-cli -testnet4 -datadir=${T4_DATADIR}"
RTCLI="sudo -u bitcoin /usr/local/bin/bitcoin-cli -regtest -datadir=${RT_DATADIR}"

wait_rpc() { # cli-string name
  for _ in $(seq 1 60); do
    if $1 getblockchaininfo >/dev/null 2>&1; then log "$2 RPC ready"; return 0; fi
    sleep 2
  done
  log "FATAL: $2 RPC not ready after 120s"; exit 1
}
wait_rpc "$T4CLI" "testnet4"
wait_rpc "$RTCLI" "regtest"

# ── 6. Wallets: vault-keys (keyed) → deposits (watch-only) → release ───────
setup_wallets() { # cli-string label
  local CLI="$1" NET="$2"
  if ! $CLI listwallets | grep -q btcsoq-vault-keys; then
    $CLI -named createwallet wallet_name=btcsoq-vault-keys load_on_startup=true >/dev/null \
      || $CLI loadwallet btcsoq-vault-keys >/dev/null
    log "$NET: created btcsoq-vault-keys"
  fi
  if ! $CLI listwallets | grep -q btcsoq-deposits; then
    $CLI -named createwallet wallet_name=btcsoq-deposits disable_private_keys=true blank=true load_on_startup=true >/dev/null \
      || $CLI loadwallet btcsoq-deposits >/dev/null
    # Import the PUBLIC tr() descriptors from vault-keys as active ranged descriptors
    local IMP
    IMP=$($CLI -rpcwallet=btcsoq-vault-keys listdescriptors | jq -c '
      [.descriptors[] | select(.desc | startswith("tr(")) |
       {desc: .desc, active: true, internal: .internal, timestamp: "now", range: 10000}]')
    $CLI -rpcwallet=btcsoq-deposits importdescriptors "$IMP" >/dev/null
    log "$NET: created btcsoq-deposits (watch-only, active tr() descriptors imported)"
  fi
  if ! $CLI listwallets | grep -q btcsoq-release; then
    $CLI -named createwallet wallet_name=btcsoq-release load_on_startup=true >/dev/null \
      || $CLI loadwallet btcsoq-release >/dev/null
    log "$NET: created btcsoq-release"
  fi
}
setup_wallets "$T4CLI" "testnet4"
setup_wallets "$RTCLI" "regtest"

# Regtest: miner wallet + initial coins
if ! $RTCLI listwallets | grep -q miner; then
  $RTCLI -named createwallet wallet_name=miner load_on_startup=true >/dev/null || $RTCLI loadwallet miner >/dev/null
fi
MINER_ADDR=$($RTCLI -rpcwallet=miner getnewaddress "mining" bech32m)
BLOCKS=$($RTCLI getblockcount)
if [ "$BLOCKS" -lt 101 ]; then
  $RTCLI generatetoaddress 101 "$MINER_ADDR" >/dev/null
  log "regtest: mined 101 blocks to miner"
fi

# ── 7. Faucet float address (testnet4 release wallet) ──────────────────────
FAUCET_ADDR=$($T4CLI -rpcwallet=btcsoq-release getnewaddress "faucet-float" bech32m)

# Smoke: fresh P2TR from the WATCH-ONLY deposits wallet on both networks
T4_DEP_SMOKE=$($T4CLI -rpcwallet=btcsoq-deposits getnewaddress "smoke-test" bech32m)
RT_DEP_SMOKE=$($RTCLI -rpcwallet=btcsoq-deposits getnewaddress "smoke-test" bech32m)

log "======================= SETUP COMPLETE ======================="
log "testnet4 IBD progress: $($T4CLI getblockchaininfo | jq -r '.blocks, .headers, .verificationprogress' | tr '\n' ' ')"
log "regtest height: $($RTCLI getblockcount)"
log "FAUCET FLOAT ADDRESS (testnet4, btcsoq-release): ${FAUCET_ADDR}"
log "watch-only deposit derivation smoke test t4: ${T4_DEP_SMOKE}"
log "watch-only deposit derivation smoke test rt: ${RT_DEP_SMOKE}"
log "RPC creds: ${CRED_FILE} (root-only; copy into relayer .env, never commit)"
