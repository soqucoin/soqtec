#!/bin/bash
# ============================================================
# Deploy Test pSOQ Token on Solana Devnet
# Run this AFTER getting devnet SOL via: solana airdrop 1
# ============================================================
set -e

export PATH="/Users/caseymacmini/.local/share/solana/install/active_release/bin:$PATH"

NETWORK="${1:-devnet}"
echo "🚀 Deploying test pSOQ on Solana $NETWORK"
echo ""

# Ensure we're on the right network
solana config set --url $NETWORK

# Check balance
BALANCE=$(solana balance 2>&1)
echo "💰 Current SOL balance: $BALANCE"

if [[ "$BALANCE" == "0 SOL" ]]; then
    echo "❌ No SOL! Run: solana airdrop 1 --url $NETWORK"
    echo "   Or visit: https://faucet.solana.com"
    exit 1
fi

echo ""
echo "📦 Step 1: Creating pSOQ token mint (9 decimals)..."
MINT_OUTPUT=$(spl-token create-token --decimals 9 2>&1)
echo "$MINT_OUTPUT"
MINT=$(echo "$MINT_OUTPUT" | grep "Address:" | awk '{print $2}')
echo "✅ Mint: $MINT"

echo ""
echo "📦 Step 2: Creating token account..."
ACCT_OUTPUT=$(spl-token create-account $MINT 2>&1)
echo "$ACCT_OUTPUT"
ACCT=$(echo "$ACCT_OUTPUT" | grep "Creating account" | awk '{print $3}')
echo "✅ Account: $ACCT"

echo ""
echo "📦 Step 3: Minting 1,000,000,000 tpSOQ..."
spl-token mint $MINT 1000000000 2>&1
echo "✅ Minted 1B test pSOQ"

echo ""
echo "=========================================="
echo "  TEST pSOQ DEPLOYMENT COMPLETE"
echo "=========================================="
echo ""
echo "  Network:        $NETWORK"
echo "  Mint Address:   $MINT"
echo "  Token Account:  $ACCT"
echo "  Mint Authority: $(solana address)"
echo "  Decimals:       9"
echo "  Supply:         1,000,000,000 tpSOQ"
echo ""
echo "  Save the mint address — you'll need it in:"
echo "    - soqtec/programs/soqtec-bridge/src/lib.rs"
echo "    - soqtec/relayer/src/config.ts"
echo "    - soqu-web/soqtec/script.js"
echo "=========================================="

# Save deployment info
cat > /Users/caseymacmini/soqtec/scripts/devnet-token-info.json << EOF
{
  "network": "$NETWORK",
  "mint": "$MINT",
  "tokenAccount": "$ACCT",
  "mintAuthority": "$(solana address)",
  "decimals": 9,
  "supply": "1000000000",
  "symbol": "tpSOQ",
  "name": "pSOQ (Devnet Test)",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo ""
echo "📁 Token info saved to: soqtec/scripts/devnet-token-info.json"
