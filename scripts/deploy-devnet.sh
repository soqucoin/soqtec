#!/usr/bin/env bash
# SOQ-TEC Bridge — Devnet Deployment Script
#
# Prerequisites:
#   - Anchor CLI installed (anchor --version)
#   - Solana CLI configured for devnet (solana config set --url devnet)
#   - Deployer keypair funded with devnet SOL
#
# Usage:
#   ./scripts/deploy-devnet.sh

set -euo pipefail

echo "╔════════════════════════════════════════╗"
echo "║   SOQ-TEC Bridge — Devnet Deployment   ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Check prerequisites
command -v anchor >/dev/null 2>&1 || { echo "❌ anchor CLI not found"; exit 1; }
command -v solana >/dev/null 2>&1 || { echo "❌ solana CLI not found"; exit 1; }

# Verify devnet
CLUSTER=$(solana config get | grep "RPC URL" | awk '{print $NF}')
echo "Cluster: $CLUSTER"
if [[ "$CLUSTER" != *"devnet"* ]]; then
  echo "⚠️  Not on devnet! Switching..."
  solana config set --url devnet
fi

# Check balance
BALANCE=$(solana balance | awk '{print $1}')
echo "Balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2" | bc -l) )); then
  echo "⚠️  Low balance. Requesting airdrop..."
  solana airdrop 2
  sleep 5
fi

# Build
echo ""
echo "Building bridge program..."
anchor build

# Deploy
echo ""
echo "Deploying to devnet..."
anchor deploy --provider.cluster devnet

# Extract program ID
PROGRAM_ID=$(solana-keygen pubkey target/deploy/soqtec_bridge-keypair.json 2>/dev/null || echo "unknown")
echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "  ✅ Deployment successful!"
echo "  Program ID: $PROGRAM_ID"
echo "  Network:    Solana Devnet"
echo "  Explorer:   https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo "╚════════════════════════════════════════════════════╝"
echo ""
echo "Next: Update SOLANA_PROGRAM_ID in relayer/.env"
