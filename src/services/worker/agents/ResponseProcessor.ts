
import { logger } from '../../../utils/logger.js';
import { gateObservationPersistence } from './ObservationQualityGate.js';
import { parseAgentXml, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import {
  classifyObserverOutput,
  isAuthFailureObserverOutput,
  isContextOverflowObserverOutput,
  isQuotaLimitedObserverOutput,
  isTransportFailureObserverOutput,
  previewOutput,
} from '../../../sdk/output-classifier.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { notifyTelegram } from '../../integrations/TelegramNotifier.js';
import { notifyGrokBotAwareness } from '../../integrations/GrokBotAwarenessPusher.js';
import { notifyGrokBotBrainbeat } from '../../integrations/GrokBotBrainbeat.js';
import { notifyGrokBotIndex } from '../../integrations/GrokBotIndexWriter.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { recordObserverFailure, recordObserverSuccess } from '../../../shared/observer-health.js';
import { clearQuotaCooldown, GATEWAY_PAUSED_WINDOW, GATEWAY_RETRY_WINDOW } from '../../../shared/quota-cooldown.js';
import { gatewayDispositionFromText } from '../gateway-disposition.js';
import { recycleObserverConversation } from '../session/recycle-conversation.js';
import { clearRejectedOutput, recordRejectedOutput } from '../session/OutputRecovery.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { ActiveSession, PendingMessage } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { telemetryBuffer } from '../../telemetry/buffer.js';

import { extractObservationFileEvidence, sanitizeObservationFiles, normalizeSummaryForStorage,
  attachObservationFilesToSummary } from './ObservationNormalization.js';
export { extractObservationFileEvidence, sanitizeObservationFiles, normalizeSummaryForStorage,
  attachObservationFilesToSummary } from './ObservationNormalization.js';
export type { ObservationFileEvidence } from './ObservationNormalization.js';

export interface ResponseContext {
  project: string;
  promptNumber: number;
  pendingAgentId: string | null;
  pendingAgentType: string | null;
}

export function snapshotResponseContext(session: ActiveSession): ResponseContext {
  return {
    project: session.project,
    promptNumber: session.lastPromptNumber,
    pendingAgentId: session.pendingAgentId ?? null,
    pendingAgentType: session.pendingAgentType ?? null,
  };
}

/**
 * An accepted reply proves the conversation fits and the provider is alive, so
 * the overflow, stall, rate-limit and unattended-gateway-resume debts reset — but only when the reply answered queued
 * work. The init prompt is answered on every fresh generation, so letting it
 * reset the debt meant an oversized message or a too-small budget went
 * init -> reset -> recycle -> restart forever and never reached the exhausted
 * pause (#4066). With the Claude feed paced to one unanswered prompt,
 * lastGeneratorSource names the prompt this reply answers.
 */
/**
 * Drifted replies allowed in a row before the generation is ended so the next
 * one starts from the schema. A clean reply resets the count.
 */
const MAX_CONSECUTIVE_SCHEMA_DRIFTS = 3;

/**
 * A reply that drifted off the observation schema (#3461: `<kind>`/`<detail>`
 * for `<type>`/`<title>`). Its rows were salvaged and stored, so nothing is
 * asked again; what must not survive is the drifted turn itself — left in the
 * conversation, it is the example the model copies for the rest of the
 * generation. Replace it with the canonical XML of what was stored, remind the
 * next observation prompt of the schema, and after
 * MAX_CONSECUTIVE_SCHEMA_DRIFTS in a row end the generation (abort reason
 * 'drift', preserved) so the next one starts clean.
 */
function correctSchemaDrift(
  session: ActiveSession,
  text: string,
  observations: ParsedObservation[],
  driftedTags: string[],
  agentName: string,
): void {
  session.consecutiveSchemaDrifts = (session.consecutiveSchemaDrifts ?? 0) + 1;
  const history = session.conversationHistory;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role === 'assistant' && history[index].content === text) {
      history[index] = { role: 'assistant', content: observations.map(renderObservationXml).join('\n') };
      break;
    }
  }
  session.observerSchemaReminder = true;
  logger.warn('PARSER', `${agentName} reply used tags outside the observation schema; stored the salvaged rows and corrected the turn`, {
    sessionId: session.sessionDbId,
    driftedTags,
    consecutiveSchemaDrifts: session.consecutiveSchemaDrifts,
  });

  if (session.consecutiveSchemaDrifts >= MAX_CONSECUTIVE_SCHEMA_DRIFTS) {
    logger.error('PARSER', `${agentName} drifted off the observation schema ${session.consecutiveSchemaDrifts} times in a row; starting a fresh generation`, {
      sessionId: session.sessionDbId,
      driftedTags,
    });
    session.consecutiveSchemaDrifts = 0;
    session.abortReason = 'drift:observer_schema';
    try {
      session.abortController.abort();
    } catch {
      // best-effort; AbortController.abort() should not throw in normal use.
    }
  }
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One stored observation in the schema's own XML, for the corrected turn. */
function renderObservationXml(observation: ParsedObservation): string {
  const field = (name: string, value: string | null) =>
    value ? `  <${name}>${escapeXmlText(value)}</${name}>` : null;
  const list = (wrapper: string, element: string, values: string[]) =>
    values.length > 0
      ? `  <${wrapper}>${values.map(value => `<${element}>${escapeXmlText(value)}</${element}>`).join('')}</${wrapper}>`
      : null;
  return [
    '<observation>',
    field('type', observation.type),
    field('title', observation.title),
    field('subtitle', observation.subtitle),
    list('facts', 'fact', observation.facts),
    field('narrative', observation.narrative),
    list('concepts', 'concept', observation.concepts),
    list('files_read', 'file', observation.files_read),
    list('files_modified', 'file', observation.files_modified),
    '</observation>',
  ].filter((line): line is string => line !== null).join('\n');
}

/**
 * Whether the next observation prompt should restate the schema, after a
 * drifted reply. Reading it consumes it: one reminder per drift.
 */
export function takeObserverSchemaReminder(session: ActiveSession): boolean {
  const remind = session.observerSchemaReminder === true;
  session.observerSchemaReminder = false;
  return remind;
}

function clearDebtForAnsweredWork(session: ActiveSession): void {
  if (session.lastGeneratorSource === 'init') return;
  session.consecutiveContextOverflows = 0;
  session.consecutiveResponseStalls = 0;
  session.consecutiveRateLimitResumes = 0;
  session.consecutiveUnattendedGatewayResumes = 0;
}

export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  modelId?: string,
  responseContext?: ResponseContext,
  /** Why an empty turn was empty (block kinds only, never content), for the idle WARN line. */
  emptyOutputReason?: string
): Promise<StorageResult | null> {
  const processingStartedAt = Date.now();
  session.lastGeneratorActivity = Date.now();
  const context = responseContext ?? snapshotResponseContext(session);
  // Scoped to the reply that produced `text`: consumed here, before any branch,
  // so a later reply (from any provider) never reads one an earlier turn set.
  const finishReason = session.lastFinishReason ?? null;
  session.lastFinishReason = null;

  // Classify rejections BEFORE growing the window. "Prompt is too long", quota
  // prose and auth prose are refusals, not conversational turns; appending them
  // makes the next request strictly larger than the one that just failed, which
  // is how an overflowed session could never recover on its own (#3800).
  const isRejectionProse =
    !!text &&
    (isContextOverflowObserverOutput(text) ||
      isQuotaLimitedObserverOutput(text) ||
      isAuthFailureObserverOutput(text) ||
      isTransportFailureObserverOutput(text));

  if (text && !isRejectionProse) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  const parsed = parseAgentXml(text, session.contentSessionId);

  // Provider enum for telemetry, derived once so the invalid-output and
  // success paths stamp the same value.
  const providerName =
    session.currentProvider ??
    ({ SDK: 'claude', Gemini: 'gemini', OpenRouter: 'openrouter' } as Record<string, string>)[agentName] ??
    'claude';

  if (!parsed.valid) {
    // A model-gateway refusal returned as the whole response: its disposition
    // decides (fleet-ops model-gateway-integration §7), before any prose rule —
    // a paused route answers 503, which would otherwise read as a transport
    // fault and be written for reconciliation.
    const gateway = gatewayDispositionFromText(text);
    if (gateway?.disposition === 'failed') {
      session.consecutiveInvalidOutputs = 0;
      await sessionManager.failClaimed(session.sessionDbId, `gateway_failed:${gateway.code ?? 'unknown'}`);
      worker?.broadcastProcessingStatus?.();
      logger.error('PARSER', `${agentName} request refused by the model gateway; batch marked failed`, {
        sessionId: session.sessionDbId, code: gateway.code,
      });
      return null;
    }
    if (gateway?.disposition === 'paused' || gateway?.disposition === 'retry') {
      session.consecutiveInvalidOutputs = 0;
      await sessionManager.resetProcessingToPending(session.sessionDbId);
      session.abortReason = `quota:${gateway.disposition === 'paused' ? GATEWAY_PAUSED_WINDOW : GATEWAY_RETRY_WINDOW}`;
      try {
        session.abortController.abort();
      } catch {
        // best-effort; AbortController.abort() should not throw in normal use.
      }
      worker?.broadcastProcessingStatus?.();
      logger.warn('PARSER', gateway.disposition === 'paused'
        ? `Model gateway paused this route; ${agentName} keeps the batch and probes after the cooldown`
        : `Model gateway deferred this request; ${agentName} keeps the batch and backs off`, {
        sessionId: session.sessionDbId, code: gateway.code,
      });
      return null;
    }

    // The conversation filled up. Retire it and start a fresh generation
    // seeded with this session's own observations, rather than re-queueing into
    // a conversation that can only keep growing.
    if (isContextOverflowObserverOutput(text)) {
      await recycleObserverConversation(
        session,
        sessionManager,
        worker,
        'refused',
        `${agentName} refused the prompt as too long: ${previewOutput(text)}`,
      );
      return null;
    }

    if (isQuotaLimitedObserverOutput(text)) {
      logger.warn('PARSER', `${agentName} returned quota-limit prose — pausing generator and preserving queued batch`, {
        sessionId: session.sessionDbId,
        outputClass: 'prose',
        preview: previewOutput(text),
      });

      await sessionManager.resetProcessingToPending(session.sessionDbId);
      session.abortReason = 'quota:observer_text';
      try {
        session.abortController.abort();
      } catch {
        // best-effort; AbortController.abort() should not throw in normal use.
      }
      worker?.broadcastProcessingStatus?.();
      return null;
    }

    if (isAuthFailureObserverOutput(text)) {
      await sessionManager.resetProcessingToPending(session.sessionDbId);
      session.abortReason = 'auth:observer_text';
      try {
        session.abortController.abort();
      } catch {
        // best-effort; AbortController.abort() should not throw in normal use.
      }
      worker?.broadcastProcessingStatus?.();
      // /api/health's ai.lastInteraction: the observer is signed out and will
      // keep producing nothing until re-auth, so say so instead of "ok".
      worker?.recordAiInteraction?.({ success: false, error: 'unauthenticated', provider: providerName });
      logger.error('PARSER', `${agentName} authentication failed; run /login to preserve queued batch`, {
        sessionId: session.sessionDbId,
        outputClass: 'prose',
        remediation: '/login',
        preview: previewOutput(text),
      });
      return null;
    }

    // A response that is the child's OWN transport/API failure is not the
    // observer declining to say anything — it is the observer never having
    // run. Preserve the batch like the quota and auth cases above; confirming
    // it here would turn a transient network fault into permanent data loss
    // (#3752).
    if (gateway?.disposition === 'reconciliation' || isTransportFailureObserverOutput(text)) {
      session.consecutiveInvalidOutputs = 0;

      sessionManager.markClaimedNeedsReconciliation(session.sessionDbId);
      session.abortReason = 'transport:observer_text';
      try {
        session.abortController.abort();
      } catch {
        // best-effort; AbortController.abort() should not throw in normal use.
      }
      await sessionManager.resetProcessingToPending(session.sessionDbId);
      worker?.broadcastProcessingStatus?.();
      logger.error('PARSER', `${agentName} could not reach the provider; queued batch preserved for retry`, {
        sessionId: session.sessionDbId,
        outputClass: 'transport',
        preview: previewOutput(text),
      });
      return null;
    }

    // Classify the non-XML output so a rejected batch is visible, not silent.
    const outputClass = classifyObserverOutput(text);
    const preview = previewOutput(text);
    // The overflow/quota/auth rejections returned above, so reaching here means
    // the provider accepted this prompt and answered it. That is proof the
    // conversation fits, whether or not the answer parsed — so the recycle
    // counter resets here too. Resetting only on a valid parse let a generation
    // that answered "idle" twice in a row trip the exhausted branch and wedge.
    // An init reply does not count (#4066).
    clearDebtForAnsweredWork(session);
    const replyDiagnostics = {
      // An HTTP reply cut off at the output-token cap reads as xml/prose here;
      // name it, so a truncation is not mistaken for a skip (#3868).
      ...(finishReason ? { finishReason, truncated: finishReason === 'length' || finishReason === 'MAX_TOKENS' } : {}),
      // Only an idle turn has a shape worth naming: blank text, thinking or
      // tool_use blocks only, or no content blocks at all (#3454).
      ...(outputClass === 'idle' && emptyOutputReason ? { emptyOutputReason } : {}),
    };

    // Every mode now names the <skip_summary /> sentinel, so a reply to queued
    // work that is neither XML nor the sentinel did not answer the batch, and
    // confirming it lost the batch silently. It earns the batch one more try,
    // in a fresh generation (the reply stays out of the next request); a second
    // rejection of the same batch drops it with an error, so one stubborn batch
    // can neither loop nor stall the queue behind it. An init reply has no
    // batch, and is confirmed as before.
    const answersQueuedWork = session.lastGeneratorSource !== 'init' && session.claimedMessageIds.length > 0;
    if (answersQueuedWork && recordRejectedOutput(session) === 'retry') {
      logger.warn('PARSER', `${agentName} returned non-XML ${outputClass} response — asking for the queued batch again in a fresh generation`, {
        sessionId: session.sessionDbId,
        outputClass,
        preview,
        ...replyDiagnostics,
      });
      await sessionManager.resetProcessingToPending(session.sessionDbId);
      session.abortReason = `output_retry:${outputClass}`;
      try {
        session.abortController.abort();
      } catch {
        // best-effort; AbortController.abort() should not throw in normal use.
      }
      worker?.broadcastProcessingStatus?.();
      return null;
    }

    if (answersQueuedWork) {
      clearRejectedOutput(session);
      logger.error('PARSER', `${agentName} returned non-XML ${outputClass} response again for the same queued batch — dropping it`, {
        sessionId: session.sessionDbId,
        outputClass,
        preview,
        ...replyDiagnostics,
      });
      recordObserverFailure(providerName, `The observer answered a queued batch twice without observation XML (${outputClass}); the batch was dropped`);
    } else {
      logger.warn('PARSER', `${agentName} returned non-XML ${outputClass} response to a prompt with no queued batch`, {
        sessionId: session.sessionDbId,
        outputClass,
        preview,
        ...replyDiagnostics,
        consecutiveContextOverflows: session.consecutiveContextOverflows,
      });
    }
    // Ordinary prose is the legacy low-signal skip decision. Persist that
    // decision so reconciliation does not mislabel a completed no-op as a
    // missing model response. Transport/API failures returned above.
    sessionManager.markClaimedSkipped(session.sessionDbId, outputClass);
    await sessionManager.confirmClaimedMessages(session.sessionDbId);
    session.earliestPendingTimestamp = null;
    return null;
  }

  // Valid parse — clear the invalid-output counter so transient misses don't
  // accumulate toward a respawn across a healthy session, and clear the overflow
  // counter so recycles only ever trip on *consecutive* failures (not on an
  // init reply, #4066).
  clearRejectedOutput(session);
  clearDebtForAnsweredWork(session);

  if (!session.memorySessionId) {
    // A valid <skip_summary/> stores nothing, so it does not wait for the
    // memory session id: confirm it now. Resetting it to pending re-asked the
    // same batch, for the same final answer, until the id appeared.
    if (parsed.summary?.skipped) {
      session.lastSummaryStored = false;
      await sessionManager.confirmClaimedMessages(session.sessionDbId);
      session.earliestPendingTimestamp = null;
      worker?.broadcastProcessingStatus?.();
      return null;
    }
    logger.warn('SDK', 'memorySessionId not yet captured; deferring storage until next round', {
      sessionId: session.sessionDbId
    });
    // Reset any claimed-but-undelivered messages back to pending so they don't
    // count as "in progress" and trigger a respawn loop while we wait for the
    // memory session id to appear. The next generator pass will re-claim them.
    await sessionManager.resetProcessingToPending(session.sessionDbId);
    return null;
  }

  const { observations, summary } = parsed;
  const claimedMessages = sessionManager.getClaimedMessages(session.sessionDbId);
  const fileEvidence = extractObservationFileEvidence(claimedMessages);
  const sanitizedObservations = sanitizeObservationFiles(observations, fileEvidence);
  // Include claimed-message file evidence even for summary-only responses
  // (no parsed observations), otherwise files_read/files_edited persist as [].
  const summaryForStore = attachObservationFilesToSummary(
    normalizeSummaryForStorage(summary),
    [
      {
        files_read: fileEvidence.files_read,
        files_modified: fileEvidence.files_modified,
      },
      ...sanitizedObservations,
    ]
  );

  const sessionStore = dbManager.getSessionStore();
  // ensure registers only when the stored id is NULL. Persist against the
  // registered identity so a later turn's fresh SDK session_id cannot FK-miss
  // observations/summaries that already hang off the first id.
  const registeredMemorySessionId =
    sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId, getWorkerPort())
    || session.memorySessionId;

  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${registeredMemorySessionId} | obsCount=${sanitizedObservations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: registeredMemorySessionId
  });

  // Storage skips an observation without a title, and everything after it pairs
  // parsed observations with stored ids by position (Chroma sync, SSE, alerts,
  // the brainbeat webhook). Drop them here so one list feeds both sides: a
  // skipped row in the middle would shift every later id onto the wrong one.
  const quality = gateObservationPersistence(sanitizedObservations, claimedMessages);
  const storableObservations = quality.observations;
  if (storableObservations.length < sanitizedObservations.length) {
    logger.debug('DB', 'Filtered observations before storage', {
      sessionId: session.sessionDbId,
      dropped: sanitizedObservations.length - storableObservations.length,
      rejected: quality.rejected,
    });
  }
  const labeledObservations = storableObservations.map(obs => ({
    ...obs,
    agent_type: context.pendingAgentType,
    agent_id: context.pendingAgentId
  }));

  let result: ReturnType<typeof sessionStore.storeObservations>;
  try {
    result = sessionStore.storeObservations(
      registeredMemorySessionId,
      context.project,
      labeledObservations,
      summaryForStore,
      context.promptNumber,
      discoveryTokens,
      originalTimestamp ?? undefined,
      modelId,
      stored => {
        if (stored.observationIds.length === 0 && stored.summaryId === null) {
          sessionManager.markClaimedSkipped(session.sessionDbId,
            quality.rejected.length ? JSON.stringify({ observationFiltering: quality.rejected }) : 'valid_empty_model_decision');
        } else {
          sessionManager.markClaimedPersistedOutcome(
            session.sessionDbId,
            JSON.stringify({ ...stored, observationFiltering: {
              sourceIndices: quality.sourceIndices, rejected: quality.rejected,
            } }),
          );
        }
      },
    );
  } finally {
    session.pendingAgentId = null;
    session.pendingAgentType = null;
  }

  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${registeredMemorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: registeredMemorySessionId
  });

  // Storage is the irreversible step: confirm the batch at once, before the
  // telemetry and integration side effects below, so an exception in any of
  // them cannot replay an already-stored batch as duplicate observations.
  await sessionManager.confirmClaimedMessages(session.sessionDbId);
  session.earliestPendingTimestamp = null;
  worker?.broadcastProcessingStatus?.();

  if (parsed.schemaDrift) {
    correctSchemaDrift(session, text, labeledObservations, parsed.schemaDrift, agentName);
  } else {
    session.consecutiveSchemaDrifts = 0;
  }

  // The provider that produced THIS response (the session's), not whichever
  // provider the settings name right now.
  worker?.recordAiInteraction?.({ success: true, provider: providerName });

  session.lastSummaryStored = result.summaryId !== null;

  // Late link: point the durable tool_uses rows this batch was generated from
  // at the observation that now summarizes them. It has to happen here and not
  // at ingest — the observation did not exist yet, and neither did
  // memorySessionId. The batch's FIRST observation id owns the link (see
  // linkToolUsesToObservation), and RECEIPT-JOIN.md documents that
  // observation_id is a pointer into the batch, not a 1:1 mapping; the reliable
  // per-call join stays (content_session_id, tool_use_id).
  //
  // Never fatal: a failed link costs a back-reference, not an observation.
  const claimedToolUseIds = Array.from(new Set(
    claimedMessages
      .map(message => message.toolUseId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  ));
  const linkObservationId = firstStoredObservationId(result);
  if (claimedToolUseIds.length > 0 && linkObservationId !== undefined) {
    try {
      const linked = sessionStore.linkToolUsesToObservation({
        contentSessionId: session.contentSessionId,
        toolUseIds: claimedToolUseIds,
        observationId: linkObservationId,
        memorySessionId: registeredMemorySessionId,
      });
      logger.debug('DB', `TOOL_USES_LINKED | sessionDbId=${session.sessionDbId} | rows=${linked} | observationId=${linkObservationId}`, {
        sessionId: session.sessionDbId
      });
    } catch (error) {
      logger.warn('DB', 'tool_uses observation link failed', {
        sessionId: session.sessionDbId,
        observationId: linkObservationId,
      }, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // A store that wrote memory proves the observer pipeline works end-to-end — clear
  // the failure streak in the observer-health ledger, and release any quota
  // breaker so a re-probe that succeeds restores full speed at once rather
  // than waiting out the remaining cooldown (#3634). Codex clears its breaker
  // in query using the admitted cooldown identity: storing an earlier response
  // here must not erase a newer failure from a concurrent pool slot.
  if (result.observationIds.length > 0 || result.summaryId !== null) {
    recordObserverSuccess();
    if (session.currentProvider && session.currentProvider !== 'codex') {
      clearQuotaCooldown(session.currentProvider);
    }
  }

  // Telemetry: counts, enums, and REAL usage only (lastUsage is never an
  // estimate — providers leave it null when the API gave no usage split).
  const typeCounts: Record<string, number> = { bugfix: 0, discovery: 0, decision: 0, refactor: 0, other: 0 };
  for (const obs of labeledObservations) {
    const bucket = obs.type in typeCounts && obs.type !== 'other' ? obs.type : 'other';
    typeCounts[bucket]++;
  }
  const dominantType = (Object.entries(typeCounts) as Array<[string, number]>)
    .reduce((best, entry) => (entry[1] > best[1] ? entry : best), ['other', -1])[0];
  const usage = session.lastUsage;
  const compressionMs = session.lastPromptSentAt ? Date.now() - session.lastPromptSentAt : undefined;
  session.lastUsage = null;
  session.lastPromptSentAt = null;

  const compressionProps: Record<string, unknown> = {
    outcome: 'ok',
    duration_ms: Date.now() - processingStartedAt,
    count: result.observationIds.length,
    has_summary: session.lastSummaryStored,
    provider: providerName,
    // Settings are raw JSON passthrough, so a misconfigured model can arrive
    // as an array/null; the scrubber drops non-strings silently, which read
    // as "no model" in PostHog — stamp 'unknown' instead.
    model: typeof modelId === 'string' && modelId ? modelId : 'unknown',
    ide: session.platformSource,
    // Observed-session identity (NOT the observer): the model the user's IDE
    // session ran and its billing posture, stamped by the Stop hook. Omitted
    // when unknown — the rollup fills 'unknown' at flush time.
    observed_model: session.observedModel,
    observed_billing: session.observedBilling,
    hook: session.lastGeneratorSource,
    endpoint_class: session.endpointClass,
    compression_ms: compressionMs,
    observation_type: labeledObservations.length > 0 ? dominantType : undefined,
    obs_type_bugfix: typeCounts.bugfix,
    obs_type_discovery: typeCounts.discovery,
    obs_type_decision: typeCounts.decision,
    obs_type_refactor: typeCounts.refactor,
    obs_type_other: typeCounts.other,
  };

  if (agentName === 'SDK') {
    // Claude path: the streamed assistant message's usage.output_tokens is an
    // early-streaming placeholder (single digits), not the real count. The
    // finalized per-turn usage and cumulative cost arrive on the SDK `result`
    // message — stash the event and let ClaudeProvider fire it from there. A
    // still-stashed event here means the prior turn never produced a result
    // (abort/kill): ship it without token fields rather than lose it.
    if (session.pendingCompressionEvent) {
      telemetryBuffer.record('session_compressed', session.sessionDbId, session.pendingCompressionEvent);
    }
    session.pendingCompressionEvent = compressionProps;
  } else {
    telemetryBuffer.record('session_compressed', session.sessionDbId, {
      ...compressionProps,
      tokens_input: usage?.input,
      tokens_output: usage?.output,
      cost_usd: usage?.costUsd,
      // input > 0 guard: a gateway that reports output without input must not
      // produce a literal 0.0 ratio (it crushed per-model averages in PostHog).
      compression_ratio:
        usage && usage.input > 0 && usage.output > 0
          ? Math.round((usage.input / usage.output) * 100) / 100
          : undefined,
    });
  }

  // Alerts fire for newly stored observations only; a Tier-0 merge (#3038)
  // re-confirms a row that already alerted.
  const fresh = freshlyStoredObservations(labeledObservations, result);

  void notifyTelegram({
    observations: fresh.observations,
    observationIds: fresh.observationIds,
    project: context.project,
    memorySessionId: registeredMemorySessionId,
  });

  void notifyGrokBotAwareness({
    observations: fresh.observations,
    observationIds: fresh.observationIds,
    project: context.project,
    memorySessionId: registeredMemorySessionId,
    agentId: context.pendingAgentId,
  });

  // Optional brainbeat webhook (off unless CLAUDE_MEM_GROK_BOT_WEBHOOK_URL is set).
  // Like the alerts above, only newly stored rows fire (a dedup merge re-confirms one that already did).
  void notifyGrokBotBrainbeat({
    observations: fresh.observations,
    observationIds: fresh.observationIds,
    project: context.project,
  });

  // Growing Grok Bot INDEX: any new observation (any project) can fill a
  // thin seat diary via the house fallback, so refresh all mapped seats.
  notifyGrokBotIndex();

  await syncAndBroadcastObservations(
    labeledObservations,
    result,
    session,
    context,
    dbManager,
    worker,
    agentName,
    registeredMemorySessionId,
    projectRoot
  );

  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    context,
    dbManager,
    worker,
    agentName,
    registeredMemorySessionId
  );

  if (result.summaryId) {
    sessionManager.deliverRequestedSessionWrapup?.(session.sessionDbId);
  }
  return result;
}

/**
 * The batch's first newly stored observation id, for the tool_uses late link.
 * A Tier-0 merge (#3038) reuses a row from another session, so prefer a fresh
 * row; when every item merged, the re-confirmed canonical row is the pointer.
 */
function firstStoredObservationId(result: StorageResult): number | undefined {
  const freshIndex = result.mergedIntoExisting?.findIndex(merged => !merged) ?? 0;
  return result.observationIds[freshIndex >= 0 ? freshIndex : 0];
}

/** Parsed observations and ids for rows this batch actually stored (Tier-0 merges dropped). */
function freshlyStoredObservations<T>(
  observations: T[],
  result: StorageResult,
): { observations: T[]; observationIds: number[] } {
  // Dedup off (the default) or nothing merged: pass through untouched.
  if (!result.mergedIntoExisting?.some(Boolean)) {
    return { observations, observationIds: result.observationIds };
  }
  const freshObservations: T[] = [];
  const freshIds: number[] = [];
  result.observationIds.forEach((id, index) => {
    if (result.mergedIntoExisting?.[index]) return;
    freshObservations.push(observations[index]);
    freshIds.push(id);
  });
  return { observations: freshObservations, observationIds: freshIds };
}

async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  context: ResponseContext,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  agentName: string,
  memorySessionId: string,
  projectRoot?: string
): Promise<void> {
  if (!memorySessionId) {
    return;
  }

  // Dedupe observation IDs before sync/broadcast: storeObservations may collapse
  // multiple parsed observations onto the same row via content_hash, producing
  // duplicate IDs. Syncing them 1:1 triggers repeated Chroma "IDs already exist"
  // reconciles. See issue #2240.
  // Skip Tier-0 dedup merges (#3038): a merge reuses an existing row, so syncing
  // the new parsed content under that id would overwrite the canonical row's
  // Chroma vector and broadcast text the row does not hold.
  const handledObservationIds = new Set<number>();

  for (let observationIndex = 0; observationIndex < result.observationIds.length; observationIndex++) {
    const obsId = result.observationIds[observationIndex];
    if (result.mergedIntoExisting?.[observationIndex] || handledObservationIds.has(obsId)) continue;
    handledObservationIds.add(obsId);
    const obs = observations[observationIndex];
    if (!obs) {
      logger.warn('DB', `${agentName} storage returned observation id without matching parsed observation`, {
        sessionId: session.sessionDbId,
        obsId,
        observationIndex
      });
      continue;
    }
    const chromaStart = Date.now();

    dbManager.getChromaSync()?.syncObservation(
      obsId,
      memorySessionId,
      context.project,
      obs,
      context.promptNumber,
      result.createdAtEpoch,
      session.platformSource
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    dbManager.getCloudSync()?.notify();

    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: memorySessionId,
      session_id: session.contentSessionId,
      content_session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: context.project,
      prompt_number: context.promptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const settingValue: unknown = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;

  if (folderClaudeMdEnabled) {
    const allFilePaths: string[] = [];
    for (const obs of observations) {
      allFilePaths.push(...(obs.files_modified || []));
      allFilePaths.push(...(obs.files_read || []));
    }

    if (allFilePaths.length > 0) {
      updateFolderClaudeMdFiles(
        allFilePaths,
        context.project,
        getWorkerPort(),
        projectRoot
      ).catch(error => {
        logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: context.project }, error as Error);
      });
    }
  }
}

async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  context: ResponseContext,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  agentName: string,
  memorySessionId: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }
  if (!memorySessionId) {
    return;
  }

  const chromaStart = Date.now();

  dbManager.getChromaSync()?.syncSummary(
    result.summaryId,
    memorySessionId,
    context.project,
    summaryForStore,
    context.promptNumber,
    result.createdAtEpoch,
    session.platformSource
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  dbManager.getCloudSync()?.notify();

  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    platform_source: session.platformSource,
    request: summaryForStore!.request,
    investigated: summaryForStore!.investigated,
    learned: summaryForStore!.learned,
    completed: summaryForStore!.completed,
    next_steps: summaryForStore!.next_steps,
    notes: summaryForStore!.notes,
    project: context.project,
    prompt_number: context.promptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  updateCursorContextForProject(context.project).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: context.project }, error as Error);
  });
}
