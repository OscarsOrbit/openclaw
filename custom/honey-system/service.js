#!/usr/bin/env node
/**
 * Honey Service — Context persistence layer for OpenClaw
 * Captures conversation turns, serves them back after compaction
 * 
 * Storage priority: Neon (cloud) → SQLite (local) → JSON (fallback)
 * Port: 7779
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.HONEY_PORT || 7779;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'honey.db');
const JSON_PATH = path.join(DATA_DIR, 'honey.json');
const NEON_URL = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Storage backends
let storageMode = 'json'; // 'neon' | 'sqlite' | 'json'
let neonPool = null;
let sqliteDb = null;

// ============================================================
// Storage initialization
// ============================================================

async function initStorage() {
  // Try Neon first (cloud-persistent)
  if (NEON_URL) {
    try {
      const { Pool } = require('pg');
      neonPool = new Pool({ 
        connectionString: NEON_URL,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
      });
      
      // Test connection
      await neonPool.query('SELECT 1');
      
      // Ensure table exists (matches existing schema)
      await neonPool.query(`
        CREATE TABLE IF NOT EXISTS honey (
          id SERIAL PRIMARY KEY,
          session_key VARCHAR(255),
          turn_type VARCHAR(50) NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          metadata JSONB
        );
        CREATE INDEX IF NOT EXISTS idx_honey_session ON honey(session_key, created_at DESC);
      `);
      
      storageMode = 'neon';
      console.log('[Honey] ☁️  Neon PostgreSQL connected — cloud-persistent storage');
      return;
    } catch (e) {
      console.log('[Honey] Neon connection failed, falling back:', e.message);
      neonPool = null;
    }
  }

  // Try SQLite next (local-persistent)
  try {
    const Database = require('better-sqlite3');
    sqliteDb = new Database(DB_PATH);
    sqliteDb.exec(`
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
    storageMode = 'sqlite';
    console.log('[Honey] 💾 SQLite initialized at', DB_PATH);
    return;
  } catch (e) {
    console.log('[Honey] SQLite unavailable:', e.message);
  }

  // JSON fallback
  storageMode = 'json';
  console.log('[Honey] 📄 Using JSON fallback at', JSON_PATH);
}

// ============================================================
// JSON helpers
// ============================================================

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

// ============================================================
// API handlers
// ============================================================

async function handleCapture(body) {
  const { session_key, turn_type, content, metadata } = body;
  if (!session_key || !turn_type || !content) {
    return { error: 'Missing required fields: session_key, turn_type, content' };
  }

  const timestamp = Date.now();
  const tokenEstimate = Math.ceil(content.length / 4); // rough estimate

  if (storageMode === 'neon') {
    await neonPool.query(`
      INSERT INTO honey (session_key, turn_type, content, token_estimate, metadata)
      VALUES ($1, $2, $3, $4, $5)
    `, [session_key, turn_type, content, tokenEstimate, metadata || {}]);
    
    // Prune old entries (keep last 500 per session)
    await neonPool.query(`
      DELETE FROM honey WHERE id IN (
        SELECT id FROM honey WHERE session_key = $1 
        ORDER BY created_at DESC OFFSET 500
      )
    `, [session_key]);
    
  } else if (storageMode === 'sqlite') {
    sqliteDb.prepare(`
      INSERT INTO turns (session_key, turn_type, content, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(session_key, turn_type, content, timestamp, JSON.stringify(metadata || {}));
    
    sqliteDb.prepare(`
      DELETE FROM turns WHERE id NOT IN (
        SELECT id FROM turns WHERE session_key = ? ORDER BY timestamp DESC LIMIT 500
      ) AND session_key = ?
    `).run(session_key, session_key);
    
  } else {
    const data = loadJson();
    data.turns.push({ session_key, turn_type, content, timestamp, metadata });
    data.turns = data.turns.slice(-5000);
    saveJson(data);
  }

  return { ok: true, timestamp, storage: storageMode };
}

async function handleContext(params) {
  const session_key = params.get('session_key');
  const limit = parseInt(params.get('limit') || '20');
  const since = parseInt(params.get('since') || '0');

  if (!session_key) {
    return { error: 'Missing session_key parameter' };
  }

  let turns;
  
  if (storageMode === 'neon') {
    const sinceDate = since > 0 ? new Date(since) : new Date(0);
    const result = await neonPool.query(`
      SELECT turn_type, content, EXTRACT(EPOCH FROM created_at) * 1000 as timestamp, metadata
      FROM honey
      WHERE session_key = $1 AND created_at > $2
      ORDER BY created_at DESC
      LIMIT $3
    `, [session_key, sinceDate, limit]);
    
    turns = result.rows.reverse().map(r => ({
      turn_type: r.turn_type,
      content: r.content,
      timestamp: parseInt(r.timestamp),
      metadata: r.metadata
    }));
    
  } else if (storageMode === 'sqlite') {
    turns = sqliteDb.prepare(`
      SELECT turn_type, content, timestamp, metadata 
      FROM turns 
      WHERE session_key = ? AND timestamp > ?
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(session_key, since, limit).reverse();
    
  } else {
    const data = loadJson();
    turns = data.turns
      .filter(t => t.session_key === session_key && t.timestamp > since)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .reverse();
  }

  return { session_key, turns, count: turns.length, storage: storageMode };
}

async function handleSessions() {
  if (storageMode === 'neon') {
    const result = await neonPool.query('SELECT DISTINCT session_key FROM honey WHERE session_key IS NOT NULL');
    return { sessions: result.rows.map(r => r.session_key), storage: storageMode };
  } else if (storageMode === 'sqlite') {
    const rows = sqliteDb.prepare('SELECT DISTINCT session_key FROM turns').all();
    return { sessions: rows.map(r => r.session_key), storage: storageMode };
  } else {
    const data = loadJson();
    const sessions = [...new Set(data.turns.map(t => t.session_key))];
    return { sessions, storage: storageMode };
  }
}

async function handleStats() {
  if (storageMode === 'neon') {
    const count = await neonPool.query('SELECT COUNT(*) as count FROM honey');
    const sessions = await neonPool.query('SELECT COUNT(DISTINCT session_key) as count FROM honey');
    return { 
      total_turns: parseInt(count.rows[0].count),
      total_sessions: parseInt(sessions.rows[0].count),
      storage: 'neon ☁️',
      persistent: true,
      nuclear_proof: true
    };
  } else if (storageMode === 'sqlite') {
    const count = sqliteDb.prepare('SELECT COUNT(*) as count FROM turns').get();
    return { 
      total_turns: count.count,
      storage: 'sqlite',
      db_path: DB_PATH,
      persistent: true
    };
  } else {
    const data = loadJson();
    return { 
      total_turns: data.turns.length,
      storage: 'json',
      db_path: JSON_PATH,
      persistent: false
    };
  }
}

// GET /status — health + stats combined
async function handleStatus() {
  const stats = await handleStats();
  return {
    status: 'ok',
    uptime: process.uptime(),
    ...stats
  };
}

// ============================================================
// HTTP server
// ============================================================

async function startServer() {
  await initStorage();
  
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    try {
      // Health/status check
      if (url.pathname === '/health' || url.pathname === '/status') {
        res.end(JSON.stringify(await handleStatus()));
        return;
      }

      // GET /context?session_key=xxx&limit=20
      if (req.method === 'GET' && url.pathname === '/context') {
        const result = await handleContext(url.searchParams);
        res.end(JSON.stringify(result));
        return;
      }

      // GET /sessions
      if (req.method === 'GET' && url.pathname === '/sessions') {
        res.end(JSON.stringify(await handleSessions()));
        return;
      }

      // GET /stats
      if (req.method === 'GET' && url.pathname === '/stats') {
        res.end(JSON.stringify(await handleStats()));
        return;
      }

      // POST /capture
      if (req.method === 'POST' && url.pathname === '/capture') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const result = await handleCapture(JSON.parse(body));
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
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(PORT, () => {
    console.log(`[Honey] 🍯 Service running on http://localhost:${PORT}`);
    console.log(`[Honey] Storage: ${storageMode.toUpperCase()}`);
    if (storageMode === 'neon') {
      console.log('[Honey] ☁️  Data persisted to cloud — survives anything');
    }
  });

  return server;
}

// ============================================================
// JSONL Watcher — Auto-capture from OC session files
// ============================================================

const SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
const JSONL_DIR = path.join(SESSIONS_DIR, 'jsonl');
const fileOffsets = new Map();
const watchers = new Map();

function extractSessionKey(filePath) {
  const basename = path.basename(filePath, '.jsonl');
  return `oc-${basename.slice(0, 8)}`;
}

async function processNewLines(filePath) {
  const sessionKey = extractSessionKey(filePath);
  const currentOffset = fileOffsets.get(filePath) || 0;
  
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= currentOffset) return;
    
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(stat.size - currentOffset);
    fs.readSync(fd, buffer, 0, buffer.length, currentOffset);
    fs.closeSync(fd);
    
    fileOffsets.set(filePath, stat.size);
    
    const lines = buffer.toString('utf8').split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        if (entry.type === 'message' && entry.message) {
          const { role, content } = entry.message;
          
          if (role === 'user' || role === 'assistant') {
            let textContent = '';
            if (typeof content === 'string') {
              textContent = content;
            } else if (Array.isArray(content)) {
              textContent = content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n');
            }
            
            if (textContent && textContent.length >= 10) {
              await handleCapture({
                session_key: sessionKey,
                turn_type: role,
                content: textContent.slice(0, 4000),
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
  // Check both possible locations for JSONL files
  const dirsToCheck = [SESSIONS_DIR, JSONL_DIR];
  
  for (const dir of dirsToCheck) {
    if (!fs.existsSync(dir)) continue;
    
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
    
    for (const file of files) {
      watchSessionFile(file);
    }
    
    // Watch directory for new files
    try {
      fs.watch(dir, (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          const filePath = path.join(dir, filename);
          if (fs.existsSync(filePath)) {
            watchSessionFile(filePath);
          }
        }
      });
    } catch (e) {
      // Directory watch failed
    }
    
    console.log(`[Honey:Watcher] Monitoring ${files.length} files in ${dir}`);
  }
}

// ============================================================
// Main startup
// ============================================================

let server;

startServer().then(s => {
  server = s;
  setTimeout(scanAndWatchSessions, 1000);
}).catch(e => {
  console.error('[Honey] Failed to start:', e.message);
  process.exit(1);
});

// ============================================================
// Graceful shutdown
// ============================================================

async function shutdown() {
  console.log('[Honey] Shutting down...');
  for (const watcher of watchers.values()) watcher.close();
  if (sqliteDb) sqliteDb.close();
  if (neonPool) await neonPool.end();
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
