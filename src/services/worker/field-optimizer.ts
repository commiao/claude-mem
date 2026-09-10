import { serializeObservationField, normalizeToolResult, ObservationPreparationError } from '../../sdk/observation-field.js';
/** Bounded field preparation. Claude uses strict admission: failure is
 * deferred durably by its caller, never treated as a complete observation.
 * Legacy providers retain their existing fallback until independently migrated.
 */

import { OBS_PROMPT_FIELD_MAX_CHARS } from '../../sdk/prompts.js';
import { logger } from '../../utils/logger.js';

/**
 * A single bounded model call: condense `text` to at most `budgetChars`.
 * Returns null when the provider cannot do it. Supplied by each provider so
 * this module stays free of provider wiring and is testable on its own.
 */
export type FieldCompressor = (text: string, budgetChars: number, signal?: AbortSignal) => Promise<string | null>;

/** How long one compression pass may run before the observer gives up on it. */
export const FIELD_OPTIMIZE_TIMEOUT_MS = 30_000;

/**
 * Target size for compressed output, as a fraction of the per-field budget.
 * Leaves headroom so a slightly-over reply still fits rather than being thrown
 * away for missing the cap by a few characters.
 */
const FIELD_OPTIMIZE_TARGET_RATIO = 0.8;

export function buildFieldCompressionPrompt(text: string, budgetChars: number): string {
  return `Condense the tool payload below to under ${budgetChars} characters.

It is going into an observation record, so preserve everything that carries
signal: file paths, identifiers, commands, counts, error text, status codes, and
any concrete values a later reader would need. Preserve release constraints,
negations, uncertainty, and conditions attached to conclusions. Drop repetition, boilerplate and
filler. Keep the original ordering.

Reply with the condensed payload only — no preamble, no commentary, no code
fences.

<payload>
${text}
</payload>`;
}

async function withTimeout<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work,
      new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, ms);
        timer.unref?.();
      }),
    ]);
    if (controller.signal.aborted) {
      // Cancellation must settle before admission returns. Bounded grace is a
      // visible failure, not permission to accept a late answer or retry.
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work.catch(error => {
            if (error instanceof ObservationPreparationError && error.reason === 'compression-cleanup-unconfirmed') throw error;
            return null;
          }),
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new ObservationPreparationError('compression-cleanup-unconfirmed')), 5000);
          }),
        ]);
      } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      return null;
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Condense one field if it is over budget.
 *
 * Strict callers get an explicit error for unusable summaries. Legacy callers
 * retain their original-value fallback. Both measure final serialized output.
 */
export async function optimizeField(
  value: unknown,
  compress: FieldCompressor,
  context: { sessionDbId: number; field: string; toolName?: string; strict?: boolean; timeoutMs?: number },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
): Promise<unknown> {
  if (context.field === 'outcome') value = normalizeToolResult(value);
  const raw = serializeObservationField(value);
  if (raw.length <= maxChars) {
    return value;
  }

  const budget = Math.floor(maxChars * FIELD_OPTIMIZE_TARGET_RATIO);
  let condensed: string | null = null;
  const controller = new AbortController();
  try {
    condensed = await withTimeout(compress(raw, budget, controller.signal), context.timeoutMs ?? FIELD_OPTIMIZE_TIMEOUT_MS, controller);
  } catch (error) {
    if (context.strict) throw error instanceof ObservationPreparationError ? error : new ObservationPreparationError('compression-failed');
    logger.warn('SDK', 'Oversized field compression failed; falling back to truncation', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      originalChars: raw.length,
    }, error instanceof Error ? error : new Error(String(error)));
    return value;
  }

  const trimmed = condensed?.trim();
  const wrapped = `<condensed original_size_chars="${raw.length}" reason="oversize">\n${trimmed ?? ''}\n</condensed>`;
  if (!trimmed || serializeObservationField(wrapped).length > maxChars) {
    if (context.strict) throw new ObservationPreparationError(controller.signal.aborted ? 'compression-timeout' : !trimmed ? 'compression-empty' : 'compressed-field-over-budget');
    logger.warn('SDK', 'Oversized field compression unusable; falling back to truncation', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      originalChars: raw.length,
      returnedChars: trimmed?.length ?? 0,
      reason: !trimmed ? 'empty-or-timeout' : 'still-over-budget',
    });
    return value;
  }

  logger.info('SDK', 'Condensed an oversized observation field to fit', {
    sessionId: context.sessionDbId,
    field: context.field,
    toolName: context.toolName,
    originalChars: raw.length,
    condensedChars: trimmed.length,
  });

  // This labels a model summary, not a proof of semantic completeness.
  return wrapped;
}

/**
 * Condense whichever of an observation's two payload fields are over budget,
 * so the observation can then be built and sent at full fidelity-per-token.
 */
export async function optimizeObservationFields(
  fields: { toolInput: unknown; toolOutput: unknown },
  compress: FieldCompressor,
  context: { sessionDbId: number; toolName?: string; strict?: boolean; timeoutMs?: number },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
): Promise<{ toolInput: unknown; toolOutput: unknown }> {
  const results = await Promise.allSettled([
    optimizeField(fields.toolInput, compress, { ...context, field: 'parameters' }, maxChars),
    optimizeField(fields.toolOutput, compress, { ...context, field: 'outcome' }, maxChars),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const [toolInput, toolOutput] = results.map(result => (result as PromiseFulfilledResult<unknown>).value);
  return { toolInput, toolOutput };
}
