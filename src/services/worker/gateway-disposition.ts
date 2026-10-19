/**
 * The model gateway's disposition field: what the caller must do next with an
 * error. Its only source is credvault `model_gateway.py` `outcome_disposition()`;
 * the rules are fleet-ops model-gateway-integration §7 (v1.2).
 *
 *   retry           refused before any provider call. Wait `retry_after_seconds`
 *                   (or a bounded backoff); same_key=true reuses the idempotency
 *                   key, false needs a new key.
 *   paused          the route is paused (business breaker, provider circuit,
 *                   daily quota, gateway config). Stop sending, probe on a long
 *                   bounded interval, never book it as a failure.
 *   failed          terminal. Never retry the same request.
 *   reconciliation  outcome unknown, possibly billed. The only case that is
 *                   written for reconciliation.
 *
 * The same code can carry opposite dispositions (`cost_limit_exceeded` is
 * `retry` for a per-minute admission limit and `failed` for a cost cap), so
 * callers decide from the disposition, never from the code. An error without
 * the field (gateway 500, a network fault) is handled as `reconciliation`.
 */
export type GatewayDispositionKind = 'retry' | 'paused' | 'failed' | 'reconciliation';

export interface GatewayDisposition {
  disposition: GatewayDispositionKind;
  sameKey: boolean;
  retryAfterMs?: number;
  code?: string;
  message?: string;
}

const KINDS = new Set<string>(['retry', 'paused', 'failed', 'reconciliation']);

/** Read the fields from one error object; null when it carries no disposition. */
export function readGatewayDisposition(error: unknown): GatewayDisposition | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  if (typeof e.disposition !== 'string' || !KINDS.has(e.disposition)) return null;
  const seconds = e.retry_after_seconds;
  return {
    disposition: e.disposition as GatewayDispositionKind,
    sameKey: e.same_key === true,
    ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1000 } : {}),
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(typeof e.message === 'string' ? { message: e.message } : {}),
  };
}

/** Queue `job.error`: a missing or unknown disposition is reconciliation (§7.2). */
export function jobErrorDisposition(error: unknown): GatewayDisposition {
  return readGatewayDisposition(error) ?? {
    disposition: 'reconciliation', sameKey: false,
    ...(error && typeof (error as any).code === 'string' ? { code: (error as any).code } : {}),
  };
}

/**
 * The gateway error inside an HTTP error body: `/v1/messages` nests it as
 * `{type:'error', error:{...}}`, `/v1/invoke` and the queue as `{error:{...}}`.
 */
export function bodyGatewayDisposition(body: unknown): GatewayDisposition | null {
  if (!body || typeof body !== 'object') return null;
  return readGatewayDisposition((body as any).error) ?? readGatewayDisposition(body);
}

/**
 * The Claude CLI hands a gateway refusal back as the whole response text,
 * `API Error: 503 {"type":"error","error":{...}}`. Anchored at both ends so an
 * observer narrating an old incident is never read as one.
 */
export function gatewayDispositionFromText(text: string): GatewayDisposition | null {
  const match = /^\s*api error:\s*\d{3}\s+(\{[\s\S]*\})\s*$/i.exec(text);
  if (!match) return null;
  try { return bodyGatewayDisposition(JSON.parse(match[1])); } catch { return null; }
}
