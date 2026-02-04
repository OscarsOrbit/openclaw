/**
 * Honey Plugin — Context persistence for OpenClaw
 * Captures turns, injects recovered context after compaction
 */

const HONEY_URL = 'http://localhost:7779';

export default function register(api: any) {
  const logger = api.logger?.child?.({ plugin: 'honey' }) || console;

  // Register a service to verify Honey is running
  api.registerService?.({
    id: 'honey-monitor',
    start: async () => {
      try {
        const resp = await fetch(`${HONEY_URL}/health`);
        if (resp.ok) {
          logger.info('[Honey] Service connected');
        } else {
          logger.warn('[Honey] Service not responding');
        }
      } catch (e: any) {
        logger.warn('[Honey] Service not reachable:', e.message);
      }
    },
    stop: () => {
      logger.info('[Honey] Monitor stopped');
    }
  });

  // Hook: Capture turns after agent replies
  api.registerHook?.('after_agent_reply', async (ctx: any) => {
    try {
      const session_key = ctx.channel || ctx.sessionKey || 'default';

      // Capture user message
      if (ctx.userMessage) {
        await fetch(`${HONEY_URL}/capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_key,
            turn_type: 'user',
            content: ctx.userMessage,
            metadata: { channel: ctx.channel, timestamp: Date.now() }
          })
        }).catch(() => {});
      }

      // Capture agent reply
      if (ctx.agentReply) {
        await fetch(`${HONEY_URL}/capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_key,
            turn_type: 'assistant',
            content: ctx.agentReply,
            metadata: { channel: ctx.channel, timestamp: Date.now() }
          })
        }).catch(() => {});
      }
    } catch (e: any) {
      // Silent fail
    }
  });

  // Hook: Inject context before agent starts (after compaction)
  api.registerHook?.('before_agent_start', async (ctx: any) => {
    try {
      const session_key = ctx.channel || ctx.sessionKey || 'default';

      const resp = await fetch(`${HONEY_URL}/context?session_key=${session_key}&limit=30`);
      if (!resp.ok) return ctx;

      const data = await resp.json();

      if (data.turns && data.turns.length > 0) {
        const formatted = data.turns.map((t: any) => {
          const role = t.turn_type === 'user' ? 'Oscar' : 'Splinter';
          const time = new Date(t.timestamp).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
          return `${role} [${time}] ${t.content}`;
        }).join('\n');

        ctx.recoveredContext = `## Recent Context (recovered from Honey)\n\n${formatted}\n\n---\n\n`;
      } else {
        ctx.recoveredContext = `## Recent Context (recovered from Honey)\n\n## No recent honey available\n\n---\n\n`;
      }
    } catch (e: any) {
      ctx.recoveredContext = `## Recent Context (recovered from Honey)\n\n## No recent honey available\n\n---\n\n`;
    }

    return ctx;
  });

  // RPC: Check honey status
  api.registerGatewayMethod?.('honey.status', async ({ respond }: any) => {
    try {
      const resp = await fetch(`${HONEY_URL}/health`);
      const data = await resp.json();
      respond(true, { connected: true, ...data });
    } catch (e: any) {
      respond(true, { connected: false, error: e.message });
    }
  });

  // RPC: Get recent context
  api.registerGatewayMethod?.('honey.context', async ({ params, respond }: any) => {
    try {
      const session_key = params?.session_key || 'default';
      const limit = params?.limit || 20;
      const resp = await fetch(`${HONEY_URL}/context?session_key=${session_key}&limit=${limit}`);
      const data = await resp.json();
      respond(true, data);
    } catch (e: any) {
      respond(false, { error: e.message });
    }
  });

  logger.info('[Honey] Plugin registered');
}
