#!/bin/bash
# 🍯 Honey System Setup Script
# Run this after cloning to restore the honey system

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_DIR="$HOME/.openclaw"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "🍯 Honey System Setup"
echo "===================="

# Create directories
echo "📁 Creating directories..."
mkdir -p "$OPENCLAW_DIR/workspace/honey/data"
mkdir -p "$OPENCLAW_DIR/workspace/honey/logs"
mkdir -p "$OPENCLAW_DIR/hooks/honey-inject"
mkdir -p "$LAUNCH_AGENTS"

# Install dependencies
echo "📦 Installing dependencies..."
cd "$OPENCLAW_DIR/workspace/honey"
npm install pg 2>/dev/null || echo "pg already installed or npm not available"

# Copy service
echo "📋 Copying Honey service..."
cp "$SCRIPT_DIR/service.js" "$OPENCLAW_DIR/workspace/honey/"

# Copy hook
echo "📋 Copying injection hook..."
cp "$SCRIPT_DIR/hook/handler.ts" "$OPENCLAW_DIR/hooks/honey-inject/"
cp "$SCRIPT_DIR/hook/HOOK.md" "$OPENCLAW_DIR/hooks/honey-inject/" 2>/dev/null || true

# Copy LaunchAgent
echo "🚀 Installing LaunchAgent..."
cp "$SCRIPT_DIR/com.openclaw.honey.plist" "$LAUNCH_AGENTS/"

# Check env vars
echo ""
echo "📋 Required environment variables:"
if [ -z "$NEON_DATABASE_URL" ]; then
    echo "   ⚠️  NEON_DATABASE_URL not set"
    echo "   Add to ~/.zshrc:"
    echo "   export NEON_DATABASE_URL='postgresql://...'"
else
    echo "   ✅ NEON_DATABASE_URL is set"
fi

if [ -z "$HONEY_LIMIT" ]; then
    echo "   ℹ️  HONEY_LIMIT not set (default: 30)"
fi

# Check OpenClaw config
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
if [ -f "$CONFIG_FILE" ]; then
    if grep -q '"honey-inject"' "$CONFIG_FILE"; then
        echo "   ✅ Hook in OpenClaw config"
    else
        echo "   ⚠️  Add honey-inject hook to $CONFIG_FILE"
    fi
fi

# Stop existing and start fresh
echo ""
echo "🚀 Starting Honey service..."
pkill -f "honey/service.js" 2>/dev/null || true
launchctl unload "$LAUNCH_AGENTS/com.openclaw.honey.plist" 2>/dev/null || true
sleep 1
launchctl load "$LAUNCH_AGENTS/com.openclaw.honey.plist"

# Verify
sleep 3
if curl -s http://localhost:7779/status | grep -q '"status":"ok"'; then
    STORAGE=$(curl -s http://localhost:7779/status | grep -o '"storage":"[^"]*"' | cut -d'"' -f4)
    echo "✅ Honey service running (storage: $STORAGE)"
else
    echo "❌ Honey service failed. Check logs:"
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
