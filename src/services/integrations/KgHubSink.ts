import { logger } from '../../utils/logger.js';

export interface KgHubObservation {
  id: number;
  sourceObsId: string;
  sourceDescription: string;
  name: string;
  content: string;
  referenceTime: string;
  contentSessionId: string;
  platformSource: string;
  project: string;
}

export interface KgHubSyncPayload {
  observations: KgHubObservation[];
}

let syncQueue: Promise<void> = Promise.resolve();
let lastKgHubPostStartedAt = 0;

function resolveKgHubUrl(): string | null {
  const enabled = process.env.CLAUDE_MEM_KG_HUB_ENABLED;
  if (enabled && enabled.toLowerCase() === 'false') return null;
  const raw = process.env.CLAUDE_MEM_KG_HUB_URL || process.env.KG_HUB_URL || '';
  const trimmed = raw.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : null;
}

function resolveKgHubToken(): string | null {
  const raw = process.env.CLAUDE_MEM_KG_HUB_API_TOKEN || process.env.KG_HUB_API_TOKEN || '';
  const trimmed = raw.trim();
  return trimmed || null;
}

function resolveKgHubTimeoutMs(): number {
  const raw = process.env.CLAUDE_MEM_KG_HUB_TIMEOUT_MS || '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
}

function resolveKgHubMinIntervalMs(): number {
  const raw = process.env.CLAUDE_MEM_KG_HUB_MIN_INTERVAL_MS || '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function syncObservationsToKgHub(payload: KgHubSyncPayload): Promise<void> {
  syncQueue = syncQueue
    .catch(() => undefined)
    .then(() => syncObservationsToKgHubNow(payload));
  return syncQueue;
}

async function syncObservationsToKgHubNow(payload: KgHubSyncPayload): Promise<void> {
  const baseUrl = resolveKgHubUrl();
  if (!baseUrl || payload.observations.length === 0) return;
  const token = resolveKgHubToken();
  const timeoutMs = resolveKgHubTimeoutMs();
  const minIntervalMs = resolveKgHubMinIntervalMs();

  for (const observation of payload.observations) {
    if (minIntervalMs > 0) {
      const waitMs = lastKgHubPostStartedAt + minIntervalMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
    lastKgHubPostStartedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          name: observation.name,
          episode_body: observation.content,
          source_description: observation.sourceDescription,
          source_obs_id: observation.sourceObsId,
          reference_time: observation.referenceTime,
          sync: false,
        }),
      });
      if (!response.ok) {
        logger.warn('INGEST', 'kg-hub sync returned non-OK response', {
          obsId: observation.id,
          status: response.status,
        });
      } else {
        logger.info('INGEST', 'kg-hub sync accepted observation', {
          obsId: observation.id,
          status: response.status,
          sourceObsId: observation.sourceObsId,
        });
      }
    } catch (error) {
      logger.warn('INGEST', 'kg-hub sync failed, continuing without KG write', {
        obsId: observation.id,
        sourceObsId: observation.sourceObsId,
      }, error instanceof Error ? error : undefined);
    } finally {
      clearTimeout(timeout);
    }
  }
}
