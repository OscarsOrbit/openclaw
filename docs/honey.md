---
summary: "Honey: Context persistence and recovery system for agent compaction"
read_when:
  - You want to understand how agents recover context after compaction
  - You want to configure or debug the Honey service
  - You want to understand the JSONL watcher architecture
---
# Honey — Context Persistence Layer

Honey is a context persistence system that captures conversation turns in real-time and re-injects them after compaction, giving agents continuity across context window resets.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         OpenClaw Gateway                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Agent Loop  │───▶│ Session JSONL│◀───│   fs.watch   │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│                                                  │              │
│  ┌──────────────┐                               │              │
│  │ agent:bootstrap│◀──────────────────┐         │              │
│  │    hook      │                    │         │              │
│  └──────┬───────┘                    │         │              │
│         │                            │         ▼              │
└─────────┼────────────────────────────┼─────────┼──────────────┘
          │                            │         │
          │ GET /context               │         │ POST /capture
          ▼                            │         ▼
    ┌─────────────────────────────────────────────────┐
    │              Honey Service (port 7779)          │
    │  ┌─────────────┐    ┌────────────────────────┐ │
    │  │  SQLite/JSON │◀──│  JSONL Watcher        │ │
    │  │   Storage    │    │  (fs.watch + tail)   │ │
    │  └─────────────┘    └────────────────────────┘ │
    └─────────────────────────────────────────────────┘
```

## Components

### 1. Honey Service (`~/.openclaw/workspace/honey/service.js`)

A standalone Node.js HTTP service that:
- **Captures** conversation turns via POST `/capture`
- **Serves** context via GET `/context?session_key=xxx&limit=N`
- **Watches** OC session JSONL files for real-time capture
- **Persists** to SQLite (or JSON fallback)

**Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| POST | `/capture` | Capture a turn (session_key, turn_type, content) |
| GET | `/context` | Get recent turns for a session |
| GET | `/sessions` | List all captured sessions |
| GET | `/stats` | Storage statistics |

### 2. JSONL Watcher

The service includes an `fs.watch`-based watcher that:
- Monitors `~/.openclaw/agents/main/sessions/*.jsonl`
- Tracks byte offsets per file (only reads NEW content)
- Parses JSONL entries for user/assistant turns
- Auto-captures to the `/capture` endpoint

**Session key mapping:**
- JSONL file: `43d468a4-2942-41be-a078-df0f60c3b84d.jsonl`
- Honey session key: `oc-43d468a4` (first 8 chars of UUID)

### 3. Honey-Inject Hook (`~/.openclaw/hooks/honey-inject/`)

An `agent:bootstrap` hook that:
- Fires when a session bootstraps (including after compaction)
- Queries Honey for recent context
- Injects it as `HONEY_CONTEXT` in bootstrap files

**Hook event flow:**
1. Compaction triggers → session resets
2. `agent:bootstrap` event fires
3. Hook queries `GET /context?session_key=oc-{sessionId}&limit=30`
4. Formats turns as conversation transcript
5. Injects into `bootstrapFiles` array

## Installation & Setup

### 1. Enable launchd service

```bash
# Create plist (already exists at ~/Library/LaunchAgents/com.openclaw.honey.plist)
launchctl load ~/Library/LaunchAgents/com.openclaw.honey.plist
```

### 2. Enable the honey-inject hook

```bash
openclaw hooks enable honey-inject
```

Or via config patch:
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

### 3. Verify

```bash
# Check service
curl http://localhost:7779/health

# Check hook
openclaw hooks check | grep honey

# Check watcher logs
tail -f ~/.openclaw/workspace/honey/logs/stdout.log
```

## How It Works

### Capture Flow (Real-time)

1. User sends message → OC writes to session JSONL
2. `fs.watch` detects file change
3. Watcher reads new bytes, parses JSONL
4. Extracts user/assistant turns
5. POSTs to `/capture` with session key `oc-{uuid}`

### Injection Flow (On Compaction)

1. Context hits limit → OC triggers compaction
2. Session resets → `agent:bootstrap` fires
3. Hook looks up `sessionEntry.sessionId` from event
4. Queries Honey: `GET /context?session_key=oc-{sessionId}&limit=30`
5. Formats turns as transcript with timestamps
6. Injects as `HONEY_CONTEXT` bootstrap file
7. Agent wakes with recent conversation context

## Configuration

### Honey Service

Edit `~/.openclaw/workspace/honey/service.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `PORT` | 7779 | HTTP server port |
| `SESSIONS_DIR` | `~/.openclaw/agents/main/sessions` | JSONL watch directory |

### Storage

- **SQLite** (preferred): Requires `better-sqlite3` npm package
- **JSON fallback**: Auto-used if SQLite unavailable, stores at `data/honey.json`

### Retention

Default: 500 turns per session. Older turns are pruned automatically.

## Troubleshooting

### Service not running
```bash
launchctl list | grep honey
tail ~/.openclaw/workspace/honey/logs/stderr.log
```

### Turns not capturing
Check watcher is active:
```bash
curl http://localhost:7779/stats
tail ~/.openclaw/workspace/honey/logs/stdout.log | grep Captured
```

### Hook not injecting
```bash
openclaw hooks check
# Should show: ✓ ready │ 🍯 honey-inject
```

### Wrong session key
Session mapping uses first 8 chars of UUID:
```bash
# Find your session
cat ~/.openclaw/agents/main/sessions/sessions.json | jq 'to_entries[] | {key: .key, id: .value.sessionId}'
# Query honey with oc-{first8chars}
curl "http://localhost:7779/context?session_key=oc-43d468a4&limit=5"
```

## Development

### Testing capture
```bash
# Manual capture
curl -X POST http://localhost:7779/capture \
  -H "Content-Type: application/json" \
  -d '{"session_key":"test","turn_type":"user","content":"Hello world"}'

# Check it stored
curl "http://localhost:7779/context?session_key=test&limit=5"
```

### Testing injection
```bash
# Trigger compaction
/compact

# Check HONEY_CONTEXT was injected (agent should report it)
```

## Future Improvements

- [ ] Native `agent:turn` hook event (cleaner than fs.watch)
- [ ] Cross-session context sharing
- [ ] Configurable summarization before injection
- [ ] SQLite WAL mode for better concurrent access
