# 🍯 Honey System — Compaction-Resistant Memory

Honey captures conversation turns in real-time and injects them back into context after compaction, giving Splinter persistent memory that survives the context reset.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Honey System                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐   │
│   │ JSONL Watcher│────▶│ Honey Server │◀────│ Inject Hook  │   │
│   │ (service.js) │     │  (port 7779) │     │ (handler.ts) │   │
│   └──────────────┘     └──────────────┘     └──────────────┘   │
│         │                     │                     │           │
│         ▼                     ▼                     ▼           │
│   Watches JSONL         Stores turns         On bootstrap,     │
│   session files         in memory            fetches recent    │
│   for new turns         per session          turns & injects   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Honey Server + JSONL Watcher (`service.js`)
- Runs on `localhost:7779`
- Watches `~/.openclaw/agents/main/sessions/jsonl/*.jsonl` for new turns
- Stores turns per-session with key format `oc-{first8chars-of-sessionId}`
- Provides `/context?session_key=<key>&limit=N` API

### 2. Injection Hook (`hook/handler.ts`)
- Registered in OpenClaw config as `honey-inject`
- Fires on `agent:bootstrap` events
- Reads `sessions.json` to resolve sessionId → honey key
- Injects recovered context into `HONEY_CONTEXT` bootstrap file

### 3. Extension (`extension/`)
- OpenClaw plugin definition (currently disabled in favor of standalone service)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HONEY_LIMIT` | `30` | Number of turns to inject after compaction |
| `HONEY_URL` | `http://localhost:7779` | Honey server URL |

**Our config: `HONEY_LIMIT=40`**

## Installation

### Quick Setup
```bash
./setup.sh
```

### Manual Setup

1. **Copy files to OpenClaw directories:**
```bash
cp service.js ~/.openclaw/workspace/honey/
cp -r hook/* ~/.openclaw/hooks/honey-inject/
```

2. **Start the Honey service:**
```bash
node ~/.openclaw/workspace/honey/service.js &
```

3. **Enable the hook in OpenClaw config:**
```json
{
  "hooks": {
    "internal": {
      "entries": {
        "honey-inject": { "enabled": true }
      }
    }
  }
}
```

4. **Set env var (in shell profile):**
```bash
export HONEY_LIMIT=40
```

5. **Restart OpenClaw Gateway**

## Verification

1. Have a conversation
2. Trigger compaction: `/compact`
3. Check if the agent remembers recent context
4. Test with a keyword mentioned pre-compaction

## API

### GET /context
Retrieve recent turns for a session.

```
GET http://localhost:7779/context?session_key=oc-43d468a4&limit=30
```

Response:
```json
{
  "turns": [
    {
      "turn_type": "user",
      "content": "Hello",
      "timestamp": 1770237000000
    },
    {
      "turn_type": "assistant", 
      "content": "Hi there!",
      "timestamp": 1770237001000
    }
  ]
}
```

### GET /status
Health check and stats.

```
GET http://localhost:7779/status
```

## Files

```
honey-system/
├── README.md           # This file
├── setup.sh            # Installation script
├── service.js          # Honey server + JSONL watcher (active)
├── index-standalone.js # Original standalone version (reference)
├── package.json        # Dependencies
├── hook/
│   ├── handler.ts      # Injection hook
│   └── HOOK.md         # Hook documentation
└── extension/
    ├── index.ts        # Plugin code (optional)
    └── openclaw.plugin.json
```

## Troubleshooting

### Honey not injecting after compaction
1. Check service is running: `ps aux | grep honey`
2. Check hook logs: `tail -f ~/.openclaw/logs/hooks.log`
3. Verify sessions.json has the sessionId
4. Test API directly: `curl http://localhost:7779/status`

### Missing turns
1. Check JSONL watcher is detecting files
2. Verify session key format matches

## Created
- **Date:** 2026-02-04
- **Authors:** Oscar & Splinter 🐢
- **Purpose:** Survive catastrophic compaction with memory intact
