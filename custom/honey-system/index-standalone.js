/**
 * Splinter Honey Service
 * 
 * Captures and serves conversation Honey for context continuity.
 * 
 * Endpoints:
 *   POST /honey - Store a honey entry
 *   GET /honey/fresh - Get fresh honey (last 1hr, up to 20K tokens)
 *   GET /honey/search?q=query - Search archived honey
 *   GET /health - Health check
 */

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Config
const PORT = process.env.HONEY_PORT || 18792;
const MAX_HONEY_TOKENS = 20000;
const FRESH_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CHARS_PER_TOKEN = 4; // rough estimate
const MAX_HONEY_CHARS = MAX_HONEY_TOKENS * CHARS_PER_TOKEN;

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_tprKg0ODVPT7@ep-super-boat-akkqkd4c-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

// Initialize database schema
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS honey (
        id SERIAL PRIMARY KEY,
        session_key VARCHAR(255),
        turn_type VARCHAR(50) NOT NULL, -- 'user', 'assistant', 'action', 'thinking', 'memory_recall'
        content TEXT NOT NULL,
        token_estimate INT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'
      );
      
      CREATE INDEX IF NOT EXISTS idx_honey_created_at ON honey(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_honey_session_key ON honey(session_key);
      CREATE INDEX IF NOT EXISTS idx_honey_turn_type ON honey(turn_type);
      
      -- Full text search index for archive searching
      CREATE INDEX IF NOT EXISTS idx_honey_content_search ON honey USING gin(to_tsvector('english', content));
    `);
    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

// Estimate tokens from text
function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

// Store honey entry
app.post('/honey', async (req, res) => {
  try {
    const { session_key, turn_type, content, metadata } = req.body;
    
    if (!turn_type || !content) {
      return res.status(400).json({ error: 'turn_type and content required' });
    }
    
    const token_estimate = estimateTokens(content);
    
    const result = await pool.query(
      `INSERT INTO honey (session_key, turn_type, content, token_estimate, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [session_key || 'main', turn_type, content, token_estimate, metadata || {}]
    );
    
    res.json({ 
      ok: true, 
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      token_estimate 
    });
  } catch (err) {
    console.error('Error storing honey:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get fresh honey (rolling window, token budget)
app.get('/honey/fresh', async (req, res) => {
  try {
    const windowMs = parseInt(req.query.window_ms) || FRESH_WINDOW_MS;
    const maxTokens = parseInt(req.query.max_tokens) || MAX_HONEY_TOKENS;
    const sessionKey = req.query.session_key || 'main';
    
    const cutoff = new Date(Date.now() - windowMs);
    
    // Get recent honey entries, newest first
    const result = await pool.query(
      `SELECT id, turn_type, content, token_estimate, created_at, metadata
       FROM honey
       WHERE created_at > $1 AND session_key = $2
       ORDER BY created_at DESC`,
      [cutoff, sessionKey]
    );
    
    // Build honey within token budget, keeping newest
    let totalTokens = 0;
    const freshHoney = [];
    
    for (const row of result.rows) {
      if (totalTokens + row.token_estimate > maxTokens) {
        break; // Would exceed budget
      }
      freshHoney.unshift(row); // Add to front (chronological order)
      totalTokens += row.token_estimate;
    }
    
    res.json({
      ok: true,
      honey: freshHoney,
      total_tokens: totalTokens,
      count: freshHoney.length,
      window_ms: windowMs,
      cutoff: cutoff.toISOString()
    });
  } catch (err) {
    console.error('Error fetching fresh honey:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get formatted honey as text (ready to inject into context)
app.get('/honey/context', async (req, res) => {
  try {
    const windowMs = parseInt(req.query.window_ms) || FRESH_WINDOW_MS;
    const maxTokens = parseInt(req.query.max_tokens) || MAX_HONEY_TOKENS;
    const sessionKey = req.query.session_key || 'main';
    
    const cutoff = new Date(Date.now() - windowMs);
    
    const result = await pool.query(
      `SELECT turn_type, content, created_at
       FROM honey
       WHERE created_at > $1 AND session_key = $2
       ORDER BY created_at DESC`,
      [cutoff, sessionKey]
    );
    
    // Build formatted context within budget
    let totalTokens = 0;
    const entries = [];
    
    for (const row of result.rows) {
      const tokens = estimateTokens(row.content);
      if (totalTokens + tokens > maxTokens) break;
      entries.unshift(row);
      totalTokens += tokens;
    }
    
    // Format as readable context
    const lines = entries.map(e => {
      const time = new Date(e.created_at).toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false 
      });
      const prefix = {
        'user': '👤 Oscar',
        'assistant': '🐀 Splinter',
        'thinking': '💭 Thinking',
        'action': '⚡ Action',
        'memory_recall': '🧠 Memory'
      }[e.turn_type] || e.turn_type;
      
      return `[${time}] ${prefix}:\n${e.content}`;
    });
    
    const context = lines.length > 0 
      ? `## Recent Conversation Honey (${entries.length} turns, ~${totalTokens} tokens)\n\n${lines.join('\n\n---\n\n')}`
      : '## No recent honey available';
    
    res.json({
      ok: true,
      context,
      total_tokens: totalTokens,
      count: entries.length
    });
  } catch (err) {
    console.error('Error building context:', err);
    res.status(500).json({ error: err.message });
  }
});

// Search archived honey
app.get('/honey/search', async (req, res) => {
  try {
    const query = req.query.q;
    const limit = parseInt(req.query.limit) || 10;
    const sessionKey = req.query.session_key;
    
    if (!query) {
      return res.status(400).json({ error: 'query parameter q required' });
    }
    
    let sql = `
      SELECT id, turn_type, content, token_estimate, created_at, metadata,
             ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) as rank
      FROM honey
      WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
    `;
    const params = [query];
    
    if (sessionKey) {
      sql += ` AND session_key = $2`;
      params.push(sessionKey);
    }
    
    sql += ` ORDER BY rank DESC, created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await pool.query(sql, params);
    
    res.json({
      ok: true,
      results: result.rows,
      count: result.rows.length,
      query
    });
  } catch (err) {
    console.error('Error searching honey:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'splinter-honey', port: PORT });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Stats
app.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_entries,
        SUM(token_estimate) as total_tokens,
        MIN(created_at) as oldest,
        MAX(created_at) as newest,
        COUNT(DISTINCT session_key) as sessions
      FROM honey
    `);
    res.json({ ok: true, stats: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup old honey (keep last 7 days for search, remove older)
app.post('/honey/cleanup', async (req, res) => {
  try {
    const daysToKeep = parseInt(req.query.days) || 7;
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    
    const result = await pool.query(
      'DELETE FROM honey WHERE created_at < $1 RETURNING id',
      [cutoff]
    );
    
    res.json({ 
      ok: true, 
      deleted: result.rowCount,
      cutoff: cutoff.toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🍯 Splinter Honey Service running on port ${PORT}`);
    console.log(`   POST /honey - Store honey`);
    console.log(`   GET  /honey/fresh - Get fresh honey`);
    console.log(`   GET  /honey/context - Get formatted context`);
    console.log(`   GET  /honey/search?q=query - Search archive`);
    console.log(`   GET  /health - Health check`);
    console.log(`   GET  /stats - Statistics`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
