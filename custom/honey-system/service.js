#!/usr/bin/env node
/**
 * Honey Service — Context persistence layer for OpenClaw
 * Captures conversation turns, serves them back after compaction
 * 
 * Persistence: SQLite (survives restarts, crashes, reboots)
 * Port: 7779
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 7779;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'honey.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// SQLite via better-sqlite3 or fallback to JSON
let db = null;
let useJson = false;

try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      turn_type TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_time ON turns(session_key, timestamp DESC);
  `);
  console.log('[Honey] SQLite initialized at', DB_PATH);
} catch (e) {
  console.log('[Honey] SQLite unavailable, using JSON fallback:', e.message);
  useJson = true;
}

const JSON_PATH = path.join(DATA_DIR, 'honey.json');

function loadJson() {
  try {
    return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  } catch {
    return { turns: [] };
  }
}

function saveJson(data) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
}

// API handlers
function handleCapture(body) {
  const { session_key, turn_type, content, metadata } = body;
  if (!session_key || !turn_type || !content) {
    return { error: 'Missing required fields: session_key, turn_type, content' };
  }

  const timestamp = Date.now();

  if (useJson) {
    const data = loadJson();
    data.turns.push({ session_key, turn_type, content, timestamp, metadata });
    // Keep last 1000 turns per session
    data.turns = data.turns.slice(-5000);
    saveJson(data);
  } else {
    db.prepare(`
      INSERT INTO turns (session_key, turn_type, content, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(session_key, turn_type, content, timestamp, JSON.stringify(metadata || {}));
    
    // Prune old entries (keep last 500 per session)
    db.prepare(`
      DELETE FROM turns WHERE id NOT IN (
        SELECT id FROM turns WHERE session_key = ? ORDER BY timestamp DESC LIMIT 500
      ) AND session_key = ?
    `).run(session_key, session_key);
  }

  return { ok: true, timestamp };
}

function handleContext(params) {
  const session_key = params.get('session_key');
  const limit = parseInt(params.get('limit') || '20');
  const since = parseInt(params.get('since') || '0');

  if (!session_key) {
    return { error: 'Missing session_key parameter' };
  }

  let turns;
  if (useJson) {
    const data = loadJson();
    turns = data.turns
      .filter(t => t.session_key === session_key && t.timestamp > since)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .reverse();
  } else {
    turns = db.prepare(`
      SELECT turn_type, content, timestamp, metadata 
      FROM turns 
      WHERE session_key = ? AND timestamp > ?
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(session_key, since, limit).reverse();
  }

  return { session_key, turns, count: turns.length };
}

function handleSessions() {
  if (useJson) {
    const data = loadJson();
    const sessions = [...new Set(data.turns.map(t => t.session_key))];
    return { sessions };
  } else {
    const rows = db.prepare('SELECT DISTINCT session_key FROM turns').all();
    return { sessions: rows.map(r => r.session_key) };
  }
}

function handleStats() {
  if (useJson) {
    const data = loadJson();
    return { 
      total_turns: data.turns.length,
      storage: 'json',
      db_path: JSON_PATH
    };
  } else {
    const count = db.prepare('SELECT COUNT(*) as count FROM turns').get();
    return { 
      total_turns: count.count,
      storage: 'sqlite',
      db_path: DB_PATH
    };
  }
}

// HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  res.setHeader('Content-Type', 'application/json');
  
  // Health check
  if (url.pathname === '/health') {
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), storage: useJson ? 'json' : 'sqlite' }));
    return;
  }

  // GET /context?session_key=xxx&limit=20
  if (req.method === 'GET' && url.pathname === '/context') {
    const result = handleContext(url.searchParams);
    res.end(JSON.stringify(result));
    return;
  }

  // GET /sessions
  if (req.method === 'GET' && url.pathname === '/sessions') {
    res.end(JSON.stringify(handleSessions()));
    return;
  }

  // GET /stats
  if (req.method === 'GET' && url.pathname === '/stats') {
    res.end(JSON.stringify(handleStats()));
    return;
  }

  // POST /capture
  if (req.method === 'POST' && url.pathname === '/capture') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const result = handleCapture(JSON.parse(body));
        res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[Honey] Service running on http://localhost:${PORT}`);
  console.log(`[Honey] Storage: ${useJson ? 'JSON' : 'SQLite'} at ${useJson ? JSON_PATH : DB_PATH}`);
});

// ============================================================
// JSONL Watcher — Auto-capture from OC session files
// ============================================================

const SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
const fileOffsets = new Map(); // Track byte position per file
const watchers = new Map();    // Track active watchers

function extractSessionKey(filePath) {
  // Map JSONL filename to a friendlier session key
  // e.g., a598d87b-7143-417f-9092-7fe066a17edb.jsonl → session-a598d87b
  const basename = path.basename(filePath, '.jsonl');
  return `oc-${basename.slice(0, 8)}`;
}

function processNewLines(filePath) {
  const sessionKey = extractSessionKey(filePath);
  const currentOffset = fileOffsets.get(filePath) || 0;
  
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= currentOffset) return; // No new data
    
    // Read only new content
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(stat.size - currentOffset);
    fs.readSync(fd, buffer, 0, buffer.length, currentOffset);
    fs.closeSync(fd);
    
    fileOffsets.set(filePath, stat.size);
    
    const lines = buffer.toString('utf8').split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        // Only capture message entries with user/assistant roles
        if (entry.type === 'message' && entry.message) {
          const { role, content } = entry.message;
          
          if (role === 'user' || role === 'assistant') {
            // Extract text content
            let textContent = '';
            if (typeof content === 'string') {
              textContent = content;
            } else if (Array.isArray(content)) {
              textContent = content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n');
            }
            
            if (textContent && textContent.length > 0) {
              // Skip tool calls and very short content
              if (textContent.length < 10 && !textContent.includes(' ')) return;
              
              // Capture the turn
              handleCapture({
                session_key: sessionKey,
                turn_type: role,
                content: textContent.slice(0, 2000), // Truncate long content
                metadata: { 
                  source: 'jsonl-watcher',
                  file: path.basename(filePath),
                  originalTimestamp: entry.timestamp
                }
              });
              
              console.log(`[Honey:Watcher] Captured ${role} turn for ${sessionKey} (${textContent.length} chars)`);
            }
          }
        }
      } catch (parseErr) {
        // Skip malformed lines
      }
    }
  } catch (err) {
    console.error(`[Honey:Watcher] Error processing ${filePath}:`, err.message);
  }
}

function watchSessionFile(filePath) {
  if (watchers.has(filePath)) return;
  
  // Initialize offset to current file size (don't replay history)
  try {
    const stat = fs.statSync(filePath);
    fileOffsets.set(filePath, stat.size);
  } catch {
    fileOffsets.set(filePath, 0);
  }
  
  const watcher = fs.watch(filePath, (eventType) => {
    if (eventType === 'change') {
      processNewLines(filePath);
    }
  });
  
  watchers.set(filePath, watcher);
  console.log(`[Honey:Watcher] Watching ${path.basename(filePath)}`);
}

function scanAndWatchSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.log(`[Honey:Watcher] Sessions directory not found: ${SESSIONS_DIR}`);
    return;
  }
  
  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(SESSIONS_DIR, f));
  
  for (const file of files) {
    watchSessionFile(file);
  }
  
  // Also watch the directory for new session files
  fs.watch(SESSIONS_DIR, (eventType, filename) => {
    if (filename && filename.endsWith('.jsonl')) {
      const filePath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filePath)) {
        watchSessionFile(filePath);
      }
    }
  });
  
  console.log(`[Honey:Watcher] Monitoring ${files.length} session files in ${SESSIONS_DIR}`);
}

// Start watching after server is up
setTimeout(() => {
  scanAndWatchSessions();
}, 1000);

// ============================================================
// Graceful shutdown
// ============================================================
process.on('SIGTERM', () => {
  console.log('[Honey] Shutting down...');
  for (const watcher of watchers.values()) watcher.close();
  if (db) db.close();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[Honey] Interrupted, shutting down...');
  for (const watcher of watchers.values()) watcher.close();
  if (db) db.close();
  server.close(() => process.exit(0));
});
