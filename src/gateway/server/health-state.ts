import type { Snapshot } from "../protocol/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getHealthSnapshot, type HealthSummary } from "../../commands/health.js";
import { CONFIG_PATH, STATE_DIR, loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { normalizeMainKey } from "../../routing/session-key.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

// ── Honey status cache ──────────────────────────────────────
const HONEY_URL = "http://localhost:7779";
let honeyCache: {
  connected: boolean;
  totalTurns?: number;
  totalSessions?: number;
  storage?: string;
  injectLimit?: number;
} | null = null;
let honeyCacheTs = 0;
const HONEY_CACHE_TTL_MS = 30_000; // refresh every 30s

async function fetchHoneyStatus(): Promise<typeof honeyCache> {
  const now = Date.now();
  if (honeyCache && now - honeyCacheTs < HONEY_CACHE_TTL_MS) return honeyCache;
  try {
    const resp = await fetch(`${HONEY_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) {
      honeyCache = { connected: false };
      honeyCacheTs = now;
      return honeyCache;
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const injectLimit = parseInt(process.env.HONEY_LIMIT || "100", 10);
    honeyCache = {
      connected: true,
      totalTurns: typeof data.total_turns === "number" ? data.total_turns : undefined,
      totalSessions: typeof data.total_sessions === "number" ? data.total_sessions : undefined,
      storage: typeof data.storage === "string" ? data.storage : undefined,
      injectLimit,
    };
    honeyCacheTs = now;
    return honeyCache;
  } catch {
    honeyCache = { connected: false };
    honeyCacheTs = now;
    return honeyCache;
  }
}

export function buildGatewaySnapshot(): Snapshot {
  const cfg = loadConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const mainSessionKey = resolveMainSessionKey(cfg);
  const scope = cfg.session?.scope ?? "per-sender";
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  const model = cfg.agents?.defaults?.model?.primary ?? "";
  return {
    model,
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    configPath: CONFIG_PATH,
    stateDir: STATE_DIR,
    sessionDefaults: {
      defaultAgentId,
      mainKey,
      mainSessionKey,
      scope,
    },
    honey: honeyCache ?? undefined,
  };
}

/** Enrich a snapshot with async honey status. Call after buildGatewaySnapshot(). */
export async function enrichSnapshotWithHoney(snapshot: Snapshot): Promise<void> {
  const honey = await fetchHoneyStatus();
  if (honey) snapshot.honey = honey;
}

export function getHealthCache(): HealthSummary | null {
  return healthCache;
}

export function getHealthVersion(): number {
  return healthVersion;
}

export function incrementPresenceVersion(): number {
  presenceVersion += 1;
  return presenceVersion;
}

export function getPresenceVersion(): number {
  return presenceVersion;
}

export function setBroadcastHealthUpdate(fn: ((snap: HealthSummary) => void) | null) {
  broadcastHealthUpdate = fn;
}

export async function refreshGatewayHealthSnapshot(opts?: { probe?: boolean }) {
  if (!healthRefresh) {
    healthRefresh = (async () => {
      const snap = await getHealthSnapshot({ probe: opts?.probe });
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })().finally(() => {
      healthRefresh = null;
    });
  }
  return healthRefresh;
}
