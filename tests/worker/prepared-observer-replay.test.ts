import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { withManualReplayHeaders } from '../../src/services/worker/ClaudeProvider.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

const COMMAND_ID = '598ef2c1-5479-4a8a-a081-7ce206d144d0';
const SECOND_COMMAND_ID = '698ef2c1-5479-4a8a-a081-7ce206d144d1';
const MODEL_STEP = 'a'.repeat(64);
const ENQUEUED_AT = 1_700_000_000_123;

function makeFixture() {
  const db = new Database(':memory:');
  const tasks = new ObserverTaskStore(db);
  const taskId = tasks.create({ sessionDbId: 23, contentSessionId: 's23', sourceId: 'tool-23',
    enqueuedAtEpoch: ENQUEUED_AT,
    payload: JSON.stringify({ tool_name: 'Read', tool_input: '{"path":"a"}',
      tool_response: '{"ok":true}', prompt_number: 2, cwd: '/tmp', toolUseId: 'tool-23' }) });
  const prepared = tasks.recordPreparedPrompt(taskId, `[[cm-task:${taskId}]] exact prepared prompt`, ENQUEUED_AT);
  tasks.needsReconciliation([taskId]);
  tasks.beginRetryCommand(COMMAND_ID, taskId, MODEL_STEP);
  const databaseManager = {
    getObserverTaskStore: () => tasks,
    getSessionById: () => ({ content_session_id: 's23', memory_session_id: null,
      project: '/tmp', platform_source: 'claude-code', observed_model: null,
      observed_billing: null, user_prompt: 'prompt' }),
    getSessionStore: () => ({ getLatestPromptTextFromUserPrompts: () => null,
      getPromptNumberFromUserPrompts: () => 2 }),
  } as unknown as DatabaseManager;
  const manager = new SessionManager(databaseManager);
  return { db, tasks, taskId, prepared, databaseManager, manager };
}

describe('prepared observer manual replay', () => {
  it('runs exactly once through SessionRoutes and the original Claude provider slot', async () => {
    const fixture = makeFixture();
    const { db, tasks, taskId, prepared, databaseManager, manager } = fixture;
    try {
      const admission = { permitId: COMMAND_ID, idempotencyKey: `cmretry-${COMMAND_ID}`,
        promptDigest: prepared.promptDigest, baselineActualCalls: 0 };
      const input = { commandId: COMMAND_ID, taskId, modelStepId: MODEL_STEP,
        observedVersion: tasks.get(taskId)!.version, admission };

      let claudeStarts = 0;
      const claudeProvider = {
        startSession: async () => {
          claudeStarts++;
          tasks.recordPersistedOutcome([taskId], '{"observationIds":[23]}');
        },
      };
      const routes = new SessionRoutes(manager, databaseManager, claudeProvider as any,
        { startSession: async () => { throw new Error('unexpected_gemini_start'); } } as any,
        { startSession: async () => { throw new Error('unexpected_openrouter_start'); } } as any,
        {} as any, {} as any, { finalizeSession: async () => {} } as any);

      expect(await routes.startManualReplay(23, taskId, COMMAND_ID,
        () => manager.queuePreparedReplay(input))).toBe(true);
      expect(await routes.startManualReplay(23, taskId, COMMAND_ID,
        () => manager.queuePreparedReplay(input))).toBe(false);
      const completion = routes.getManualReplayCompletion(COMMAND_ID, taskId);
      expect(completion).not.toBeNull();
      await completion;
      expect(claudeStarts).toBe(1);
      expect(tasks.get(taskId)).toMatchObject({ state: 'succeeded', outcome: '{"observationIds":[23]}' });
      expect(manager.getMessageBuffer().getPendingCount(23)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('removes a failed claimed replay so a later human command can isolate the task again', async () => {
    const { db, tasks, taskId, prepared, manager } = makeFixture();
    try {
      expect(await manager.queuePreparedReplay({ commandId: COMMAND_ID, taskId,
        modelStepId: MODEL_STEP, observedVersion: tasks.get(taskId)!.version,
        admission: { permitId: COMMAND_ID, idempotencyKey: `cmretry-${COMMAND_ID}`,
          promptDigest: prepared.promptDigest, baselineActualCalls: 0 } })).toBe(true);
      tasks.beginRetryCommand(SECOND_COMMAND_ID, taskId, MODEL_STEP);
      expect(await manager.queuePreparedReplay({ commandId: SECOND_COMMAND_ID, taskId,
        modelStepId: MODEL_STEP, observedVersion: tasks.get(taskId)!.version,
        admission: { permitId: SECOND_COMMAND_ID, idempotencyKey: `cmretry-${SECOND_COMMAND_ID}`,
          promptDigest: prepared.promptDigest, baselineActualCalls: 0 } })).toBe(false);
      expect(manager.cancelQueuedManualReplay(taskId, SECOND_COMMAND_ID)).toBe(false);
      expect(manager.getManualReplayCandidate(23)?.manualReplayCommandId).toBe(COMMAND_ID);
      const session = manager.getSession(23)!;
      const iterator = manager.getMessageIterator(23);
      const yielded = await iterator.next();
      expect(yielded.value?.manualReplayCommandId).toBe(COMMAND_ID);
      tasks.needsReconciliation([taskId]);
      expect(manager.discardClaimedManualReplay(23, taskId)).toBe(1);
      expect(manager.getMessageBuffer().getPendingCount(23)).toBe(0);
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
      await iterator.return?.();
      session.abortController.abort();
    } finally {
      db.close();
    }
  });

  it('limits permit headers to the loopback SDK environment and strips stale replay headers', () => {
    const env = withManualReplayHeaders({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:39001',
      CLAUDE_CODE_MAX_RETRIES: '9',
      ANTHROPIC_CUSTOM_HEADERS: 'X-CredVault-Replay-Prompt-SHA256: stale\nX-Model-Gateway-Step-Id: stale\nX-Other: kept',
    }, { permitId: COMMAND_ID, idempotencyKey: `cmretry-${COMMAND_ID}`, commandId: COMMAND_ID, modelStepId: MODEL_STEP });
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('0');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(`X-CredVault-Replay-Permit: ${COMMAND_ID}`);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(`Idempotency-Key: cmretry-${COMMAND_ID}`);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(`X-CredVault-Replay-Step-Id: ${MODEL_STEP}`);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('X-Other: kept');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('Prompt-SHA256');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('X-Model-Gateway-Step-Id');
    expect(() => withManualReplayHeaders({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      { permitId: COMMAND_ID, idempotencyKey: `cmretry-${COMMAND_ID}`, commandId: COMMAND_ID, modelStepId: MODEL_STEP }))
      .toThrow('manual_replay_requires_loopback_gateway');
  });
});
