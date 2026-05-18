#!/usr/bin/env bash
# Hot-swap local build into OpenCode plugin cache (if installed via npm)
# Usage: ./scripts/hot-swap.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_NAME="@firdyfirdy/opencode-multi-kiro"
CACHE_BASE="$HOME/.cache/opencode/packages"
PLUGIN_DIR="$CACHE_BASE/$PLUGIN_NAME@latest/node_modules/$PLUGIN_NAME"

echo "Building..."
cd "$PROJECT_DIR"
bun run build

if [ -d "$PLUGIN_DIR/dist" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  echo "Backing up existing dist -> dist.bak.$TS"
  cp -a "$PLUGIN_DIR/dist" "$PLUGIN_DIR/dist.bak.$TS"
  rm -rf "$PLUGIN_DIR/dist"
  cp -a "$PROJECT_DIR/dist" "$PLUGIN_DIR/dist"
  echo "Hot-swapped! Backup at: $PLUGIN_DIR/dist.bak.$TS"
else
  echo "No cached plugin found at $PLUGIN_DIR"
  echo "Using file:// plugin path instead (no hot-swap needed)"
fi

echo ""
echo "Done. Restart OpenCode to pick up changes."
