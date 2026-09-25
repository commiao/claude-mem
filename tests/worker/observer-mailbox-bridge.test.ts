import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { ObserverMailboxBridge } from '../../src/services/worker/ObserverMailboxBridge.js';

const ZERO_STEP = '0'.repeat(64);
const COMMAND_ID = 'ad566e18-e04c-47f8-a50c-365b72e2fa01';

describe('ObserverMailboxBridge', () => {
  it('checks locally, queries zero-call gateway status, and replays a command without model work', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 1, contentSessionId: 's', sourceId: 'tool-1', payload: 'private prompt' });
      tasks.needsReconciliation([taskId]);
      const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
      const command = { command_id: COMMAND_ID, task_id: taskId, model_step_id: ZERO_STEP,
        action: 'check' as const, expected_version: 1, lease_token: 'lease' };
      const bridge = new ObserverMailboxBridge(tasks, async (path, body) => {
        requests.push({ path, body });
        if (path.endsWith('/claim')) return { command };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, attempts: [], external_calls: 0 };
        return { ok: true };
      });
      await bridge.tick();
      await bridge.tick();
      expect(requests.filter(request => request.path.endsWith('/task-attempts'))).toHaveLength(1);
      expect(requests.filter(request => request.path.endsWith('/complete'))).toHaveLength(2);
      expect(requests.find(request => request.path.endsWith('/report'))?.body).toMatchObject({
        state: 'reconciliation', retryable: false, failed_attempts: 0,
      });
      expect(JSON.stringify(requests)).not.toContain('private prompt');
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
    } finally { db.close(); }
  });

  it('persists retry rejection and never queries or enqueues model work', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 2, contentSessionId: 's', sourceId: 'tool-2', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const paths: string[] = [];
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        paths.push(path);
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: 'a'.repeat(64),
          action: 'retry', expected_version: 1, lease_token: 'lease',
        } };
        return {};
      });
      await bridge.tick();
      await bridge.tick();
      expect(paths.filter(path => path.endsWith('/task-attempts'))).toHaveLength(0);
      expect(tasks.getCommandResult(COMMAND_ID)).toEqual({
        state: 'reconciliation', version: 1, reason: 'retry_identity_unproven',
      });
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
    } finally { db.close(); }
  });

  it('counts an expired admitted business attempt once, independent of billing evidence', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 3, contentSessionId: 's', sourceId: 'tool-3', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'b'.repeat(64);
      let serial = 0;
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/claim')) return { command: {
          command_id: `ad566e18-e04c-47f8-a50c-${(1 + serial++).toString(16).padStart(12, '0')}`,
          task_id: taskId, model_step_id: step, action: 'check',
          expected_version: tasks.get(taskId)?.version, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: 'c'.repeat(64), phase: 'admitted',
            provider_call_started: true, in_flight: false,
            deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(1);
      expect(tasks.get(taskId)).toMatchObject({ state: 'reconciliation', version: 2 });
    } finally { db.close(); }
  });

  it('keeps a still-in-flight request pending even beyond its deadline', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 4, contentSessionId: 's', sourceId: 'tool-4', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'd'.repeat(64);
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: 1, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: 'e'.repeat(64), phase: 'admitted',
            provider_call_started: true, in_flight: true,
            deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(0);
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
    } finally { db.close(); }
  });
});
