#!/bin/bash
# 🍯 Honey System Setup Script
# Run this after cloning to restore the honey system

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_DIR="$HOME/.openclaw"

echo "🍯 Honey System Setup"
echo "===================="

# Create directories
echo "📁 Creating directories..."
mkdir -p "$OPENCLAW_DIR/workspace/honey/data"
mkdir -p "$OPENCLAW_DIR/workspace/honey/logs"
mkdir -p "$OPENCLAW_DIR/hooks/honey-inject"

# Copy service
echo "📋 Copying Honey service..."
cp "$SCRIPT_DIR/service.js" "$OPENCLAW_DIR/workspace/honey/"

# Copy hook
echo "📋 Copying injection hook..."
cp "$SCRIPT_DIR/hook/handler.ts" "$OPENCLAW_DIR/hooks/honey-inject/"
cp "$SCRIPT_DIR/hook/HOOK.md" "$OPENCLAW_DIR/hooks/honey-inject/" 2>/dev/null || true

# Check if HONEY_LIMIT is set
if [ -z "$HONEY_LIMIT" ]; then
    echo ""
    echo "⚠️  HONEY_LIMIT not set. Add to your shell profile:"
    echo "   export HONEY_LIMIT=40"
    echo ""
fi

# Check OpenClaw config for hook
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
if [ -f "$CONFIG_FILE" ]; then
    if grep -q '"honey-inject"' "$CONFIG_FILE"; then
        echo "✅ Hook already in config"
    else
        echo "⚠️  Add honey-inject hook to $CONFIG_FILE:"
        echo '   "hooks": { "internal": { "entries": { "honey-inject": { "enabled": true } } } }'
    fi
fi

# Start service
echo ""
echo "🚀 Starting Honey service..."
pkill -f "honey/service.js" 2>/dev/null || true
sleep 1
nohup node "$OPENCLAW_DIR/workspace/honey/service.js" > "$OPENCLAW_DIR/workspace/honey/logs/honey.log" 2>&1 &
echo "   PID: $!"

# Verify
sleep 2
if curl -s http://localhost:7779/status > /dev/null 2>&1; then
    echo "✅ Honey service running on port 7779"
else
    echo "❌ Honey service failed to start. Check logs:"
    echo "   tail -f $OPENCLAW_DIR/workspace/honey/logs/honey.log"
    exit 1
fi

echo ""
echo "🍯 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Restart OpenClaw gateway: openclaw gateway restart"
echo "  2. Test: Have a conversation, run /compact, verify memory survives"
echo ""
