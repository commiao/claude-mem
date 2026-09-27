import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { ObserverMailboxBridge } from '../../src/services/worker/ObserverMailboxBridge.js';

const MODEL_STEP = 'a'.repeat(64);
const COMMAND_ID = 'ad566e18-e04c-47f8-a50c-365b72e2fa01';

describe('ObserverMailboxBridge', () => {
  it('checks locally, queries zero-call gateway status, and replays a command without model work', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 1, contentSessionId: 's', sourceId: 'tool-1', payload: 'private prompt' });
      tasks.needsReconciliation([taskId]);
      const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
      const command = { command_id: COMMAND_ID, task_id: taskId, model_step_id: MODEL_STEP,
        action: 'check' as const, expected_version: tasks.get(taskId)!.version, lease_token: 'lease' };
      const bridge = new ObserverMailboxBridge(tasks, async (path, body) => {
        requests.push({ path, body });
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, attempts: [], external_calls: 0 };
        return { ok: true };
      });
      await bridge.tick();
      await bridge.tick();
      expect(requests.filter(request => request.path.endsWith('/task-attempts'))).toHaveLength(3);
      expect(requests.filter(request => request.path.endsWith('/complete'))).toHaveLength(2);
      expect(requests.find(request => request.path.endsWith('/report'))?.body).toMatchObject({
        state: 'reconciliation', retryable: true, failed_attempts: 0,
      });
      expect(JSON.stringify(requests)).not.toContain('private prompt');
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
    } finally { db.close(); }
  });

  it('keeps a human reconcile command actionable when the original replay runtime is unavailable', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 2, contentSessionId: 's', sourceId: 'tool-2', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const paths: string[] = [];
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        paths.push(path);
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: 'a'.repeat(64),
          action: 'reconcile', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, attempts: [], external_calls: 0 };
        return {};
      });
      await bridge.tick();
      await bridge.tick();
      expect(paths.filter(path => path.endsWith('/task-attempts'))).toHaveLength(3);
      expect(tasks.getCommandResult(COMMAND_ID)).toEqual({
        state: 'reconciliation', version: 3, reason: 'manual_replay_runtime_unavailable',
      });
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
    } finally { db.close(); }
  });

  it('marks success only from the durable local business receipt before querying the gateway', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 20, contentSessionId: 's', sourceId: 'tool-20', payload: '{}' });
      tasks.recordPersistedOutcome([taskId], '{"observationIds":[20]}');
      const paths: string[] = [];
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        paths.push(path);
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: MODEL_STEP,
          action: 'reconcile', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        return {};
      });
      await bridge.tick();
      expect(paths.filter(path => path.endsWith('/task-attempts'))).toHaveLength(0);
      expect(tasks.getCommandResult(COMMAND_ID)).toEqual({
        state: 'succeeded', version: 3, reason: 'business_result_persisted',
      });
      expect(paths.lastIndexOf('/v1/reconciliation/report'))
        .toBeLessThan(paths.lastIndexOf('/v1/reconciliation/complete'));
    } finally { db.close(); }
  });

  it('dispatches one manual replay and records a completed response without receipt as a failure', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 21, contentSessionId: 's', sourceId: 'tool-21',
        payload: JSON.stringify({ tool_name: 'Read', tool_input: '{}', tool_response: '{}', prompt_number: 2 }) });
      const step = 'a'.repeat(64);
      tasks.recordPreparedPrompt(taskId, `[[cm-task:${taskId}]] exact prompt`, tasks.get(taskId)!.enqueuedAtEpoch!);
      tasks.needsReconciliation([taskId]);
      let dispatches = 0;
      let statusReads = 0;
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'reconcile', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) {
          statusReads++;
          return { task_id: taskId, external_calls: 0,
            attempts: statusReads < 3 ? [] : [{ model_step_id: step, identity: 'f'.repeat(64),
              phase: 'completed', http_request_started_at: new Date(Date.now() - 1_000).toISOString(),
              in_flight: false, http_request_deadline_at: new Date(Date.now() + 60_000).toISOString() }] };
        }
        return {};
      }, {
        dispatch: async input => {
          dispatches++;
          expect(tasks.queueManualReplay({ commandId: input.commandId, taskId: input.taskId,
            modelStepId: input.modelStepId, observedVersion: input.observedVersion,
            permitId: input.admission.permitId, idempotencyKey: input.admission.idempotencyKey,
            promptDigest: input.admission.promptDigest, baselineActualCalls: input.admission.baselineActualCalls,
          })).toMatchObject({ queued: true });
          tasks.markManualReplayRunning(input.taskId);
          return { started: true, reason: 'manual_replay_started', completed: Promise.resolve() };
        },
      });

      await bridge.tick();
      expect(dispatches).toBe(1);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', actualCalls: 1 });
      expect(tasks.getTaskBusinessFailureCount(taskId)).toBe(1);
      expect(tasks.getCommandResult(COMMAND_ID)?.reason)
        .toBe('model_call_completed_without_business_receipt_manual_retry_required');
    } finally { db.close(); }
  });

  it('moves missing original request context to failed without dispatching a model', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 21, contentSessionId: 's', sourceId: 'missing-context', payload: '{}' });
      tasks.recordPreparedPrompt(taskId, `[[cm-task:${taskId}]] original task`, tasks.get(taskId)!.enqueuedAtEpoch!);
      tasks.needsReconciliation([taskId]);
      let dispatches = 0;
      const bridge = new ObserverMailboxBridge(tasks, async path => {
        if (path.endsWith('/replay-snapshot')) return { available: false };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: MODEL_STEP,
          action: 'reconcile', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, attempts: [], external_calls: 0 };
        return {};
      }, { dispatch: async () => { dispatches++; throw new Error('must not dispatch'); } });
      await bridge.tick();
      expect(dispatches).toBe(0);
      expect(tasks.get(taskId)).toMatchObject({ state: 'failed', actualCalls: 0,
        outcome: 'original_request_snapshot_unavailable' });
      expect(tasks.getCommandResult(COMMAND_ID)?.state).toBe('failed');
    } finally { db.close(); }
  });

  it('counts an expired started HTTP request once, independent of billing evidence', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 3, contentSessionId: 's', sourceId: 'tool-3', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'b'.repeat(64);
      let serial = 0;
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: `ad566e18-e04c-47f8-a50c-${(1 + serial++).toString(16).padStart(12, '0')}`,
          task_id: taskId, model_step_id: step, action: 'check',
          expected_version: tasks.get(taskId)?.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: 'c'.repeat(64), phase: 'admitted',
            http_request_started_at: '2019-12-31T23:00:00Z', in_flight: false,
            http_request_deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(1);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', actualCalls: 1, version: 5 });
    } finally { db.close(); }
  });

  it('keeps a still-in-flight request pending before its deadline', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 4, contentSessionId: 's', sourceId: 'tool-4', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'd'.repeat(64);
      const deadline = new Date(Date.now() + 60_000).toISOString();
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: 'e'.repeat(64), phase: 'admitted',
            http_request_started_at: new Date(Date.now() - 1_000).toISOString(), in_flight: true,
            http_request_deadline_at: deadline }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(0);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', actualCalls: 1 });
    } finally { db.close(); }
  });

  it('counts a no-result HTTP call once after the deadline even if gateway in_flight is stale', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 40, contentSessionId: 's', sourceId: 'tool-40', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'e'.repeat(64);
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: 'f'.repeat(64), phase: 'unknown',
            http_request_started_at: '2019-12-31T23:00:00Z', in_flight: true,
            http_request_deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(1);
      expect(tasks.getTaskBusinessFailureCount(taskId)).toBe(1);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', actualCalls: 1 });
      expect(tasks.getCommandResult(COMMAND_ID)?.reason).toBe('deadline_expired_without_business_result');
    } finally { db.close(); }
  });

  it('does not count provider admission without a transport-start witness', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 5, contentSessionId: 's', sourceId: 'tool-5', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'f'.repeat(64);
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: '1'.repeat(64), phase: 'admitted',
            provider_admitted: true, http_request_started_at: null, in_flight: false,
            http_request_deadline_at: null }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(0);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', actualCalls: 0 });
    } finally { db.close(); }
  });

  it('counts a completed gateway response without a durable receipt as one business failure', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 6, contentSessionId: 's', sourceId: 'tool-6', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'c'.repeat(64);
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: '2'.repeat(64), phase: 'completed',
            http_request_started_at: '2019-12-31T23:00:00Z', in_flight: false,
            http_request_deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(1);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', actualCalls: 1 });
      expect(tasks.getCommandResult(COMMAND_ID)?.reason).toBe('gateway_response_without_business_receipt');
    } finally { db.close(); }
  });

  it('counts a terminal HTTP failure immediately without waiting for its deadline', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 7, contentSessionId: 's', sourceId: 'tool-7', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'd'.repeat(64);
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: '3'.repeat(64), phase: 'failed',
            http_request_started_at: '2020-01-01T00:00:00Z', in_flight: false,
            http_request_deadline_at: '2099-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(1);
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
    } finally { db.close(); }
  });

  it('uses the gateway task deadline fallback for an absent response after a started call', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 9, contentSessionId: 's', sourceId: 'tool-9', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'a'.repeat(64);
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: 'b'.repeat(64), phase: 'absent',
            http_request_started_at: '2019-12-31T23:00:00Z', in_flight: false,
            http_request_deadline_at: null, deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(1);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', actualCalls: 1 });
    } finally { db.close(); }
  });

  it('marks task failed on the third witnessed HTTP failure across different model steps', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 8, contentSessionId: 's', sourceId: 'tool-8', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const steps = ['4', '5', '6'].map(char => char.repeat(64));
      const identities = ['7', '8', '9'].map(char => char.repeat(64));
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/replay-snapshot')) return { available: true };
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: steps[0],
          action: 'reconcile', expected_version: tasks.get(taskId)!.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: steps.map((step, index) => ({ model_step_id: step, identity: identities[index], phase: 'failed',
            http_request_started_at: '2020-01-01T00:00:00Z', in_flight: false,
            http_request_deadline_at: '2020-01-01T00:00:01Z' })) };
        return {};
      });
      await bridge.tick();
      expect(tasks.getTaskBusinessFailureCount(taskId)).toBe(3);
      expect(tasks.get(taskId)).toMatchObject({ state: 'failed', outcome: 'three_failed_business_attempts' });
      expect(tasks.getCommandResult(COMMAND_ID)?.reason).toBe('three_failed_business_attempts');
    } finally { db.close(); }
  });
});
