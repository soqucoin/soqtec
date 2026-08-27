#!/usr/bin/env bash
# BTCSOQ dev relayer instance (Day-1/2 E2E) — runs BESIDE the live
# soqtec-relayer.service without touching it. Port 3002, regtest, BTCSOQ only.
set -euo pipefail

source /root/.btcsoq-rpc.env

ENVFILE=/opt/btcsoq-dev/relayer/.env
cat > "$ENVFILE" <<EOF
# BTCSOQ dev instance (Day-1 E2E) — regtest, BTCSOQ lane only
BTCSOQ_ONLY=true
BTCSOQ_ENABLED=true
BTC_NETWORK=regtest
BTC_RPC_URL=http://127.0.0.1:18443
BTC_RPC_USER=${BTC_RT_RPC_USER}
BTC_RPC_PASS=${BTC_RT_RPC_PASS}
BTC_POLL_MS=5000
BTCSOQ_DATA_DIR=/opt/btcsoq-dev/data
API_PORT=3005
EOF
chmod 600 "$ENVFILE"

cat > /etc/systemd/system/btcsoq-relayer-dev.service <<'EOF'
[Unit]
Description=BTCSOQ Gateway Relayer (DEV instance — regtest E2E, port 3005)
After=network-online.target bitcoind-regtest.service

[Service]
Type=simple
WorkingDirectory=/opt/btcsoq-dev/relayer
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now btcsoq-relayer-dev.service
sleep 3
systemctl --no-pager --lines=0 status btcsoq-relayer-dev.service | head -5
echo "--- recent log ---"
journalctl -u btcsoq-relayer-dev.service --no-pager -n 25
