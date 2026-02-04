/**
 * Honey Inject Hook — Injects recovered context after compaction
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const HONEY_URL = 'http://localhost:7779';
const SESSIONS_FILE = join(process.env.HOME || '', '.openclaw/agents/main/sessions/sessions.json');

interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: {
    bootstrapFiles?: Array<{
      path: string;
      content: string;
      position?: 'prepend' | 'append';
    }>;
    sessionEntry?: any;
    cfg?: any;
  };
}

const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') {
    return;
  }

  try {
    // Determine session key from event context
    const sessionKey = event.sessionKey || 'default';
    
    // Try to get sessionId - first from event context, then from sessions.json
    let sessionId = event.context?.sessionEntry?.sessionId;
    
    if (!sessionId) {
      try {
        const sessionsData = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
        const entry = sessionsData[sessionKey];
        if (entry?.sessionId) {
          sessionId = entry.sessionId;
        }
      } catch (e) {
        // sessions.json not available
      }
    }
    
    let honeyKey: string;
    if (sessionId) {
      // Use the JSONL watcher format: oc-{first 8 chars of sessionId}
      honeyKey = `oc-${sessionId.slice(0, 8)}`;
      console.log(`[honey-inject] Using sessionId ${sessionId} -> honeyKey: ${honeyKey}`);
    } else {
      // Fallback: extract channel from session key
      const parts = sessionKey.split(':');
      honeyKey = parts.length > 2 ? parts[2] : sessionKey;
      console.log(`[honey-inject] Fallback: sessionKey=${sessionKey} -> honeyKey=${honeyKey}`);
    }

    console.log(`[honey-inject] Looking up context for honeyKey: ${honeyKey} (from sessionKey: ${sessionKey})`);

    const limit = parseInt(process.env.HONEY_LIMIT || '30', 10);
    const resp = await fetch(`${HONEY_URL}/context?session_key=${honeyKey}&limit=${limit}`, {
      signal: AbortSignal.timeout(2000)
    });

    if (!resp.ok) {
      console.log('[honey-inject] Honey service returned non-OK status');
      return;
    }

    const data = await resp.json() as { turns?: Array<{ turn_type: string; content: string; timestamp: number }> };

    if (!data.turns || data.turns.length === 0) {
      // Inject "no honey" marker so we know injection ran
      if (Array.isArray(event.context.bootstrapFiles)) {
        event.context.bootstrapFiles.unshift({
          name: 'HONEY_CONTEXT',
          path: '/virtual/HONEY_CONTEXT',
          content: '## Recent Context (recovered from Honey)\n\n## No recent honey available\n\n---\n\n',
          missing: false
        });
      }
      return;
    }

    // Format turns
    const formatted = data.turns.map((t) => {
      const role = t.turn_type === 'user' ? 'Oscar' : 'Splinter';
      const time = new Date(t.timestamp).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      return `${role} [${time}] ${t.content}`;
    }).join('\n');

    const honeyContent = `## Recent Context (recovered from Honey)\n\n${formatted}\n\n---\n\n`;

    // Inject at start of bootstrap
    if (Array.isArray(event.context.bootstrapFiles)) {
      event.context.bootstrapFiles.unshift({
        name: 'HONEY_CONTEXT',
        path: '/virtual/HONEY_CONTEXT',
        content: honeyContent,
        missing: false
      });
      console.log(`[honey-inject] Injected ${data.turns.length} turns of context`);
    }

  } catch (e: any) {
    console.log(`[honey-inject] Error: ${e.message}`);
    // Inject marker anyway if array exists
    if (Array.isArray(event.context.bootstrapFiles)) {
      event.context.bootstrapFiles.unshift({
        name: 'HONEY_CONTEXT', 
        path: '/virtual/HONEY_CONTEXT',
        content: '## Recent Context (recovered from Honey)\n\n## No recent honey available\n\n---\n\n',
        missing: false
      });
    }
  }
};

export default handler;
