#!/usr/bin/env bash
# SOQ-TEC — Deploy Terminal Dashboard to Cloudflare Pages
#
# Usage:
#   ./scripts/deploy-terminal.sh [commit-message]
#
# Deploys the static terminal dashboard to soqtec.soqu.org via wrangler.

set -euo pipefail

COMMIT_MSG="${1:-SOQ-TEC Terminal update}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Deploying SOQ-TEC Terminal..."
echo "Project: $PROJECT_DIR"

# Deploy to Cloudflare Pages
wrangler pages deploy "$PROJECT_DIR" \
  --project-name soqtec \
  --commit-message "$COMMIT_MSG" \
  --commit-dirty=true

echo ""
echo "✅ Deployed to soqtec.soqu.org"
echo "   Also available at: soqtec.pages.dev"
