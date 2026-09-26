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

  it('counts an expired started HTTP request once, independent of billing evidence', async () => {
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
            http_request_started_at: '2019-12-31T23:00:00Z', in_flight: false,
            http_request_deadline_at: '2020-01-01T00:00:00Z' }] };
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
            http_request_started_at: '2019-12-31T23:00:00Z', in_flight: true,
            http_request_deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(0);
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
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
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: 1, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: '1'.repeat(64), phase: 'admitted',
            provider_admitted: true, http_request_started_at: null, in_flight: false,
            http_request_deadline_at: null }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(0);
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
    } finally { db.close(); }
  });

  it('does not count a completed gateway model response as an HTTP failure', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 6, contentSessionId: 's', sourceId: 'tool-6', payload: '{}' });
      tasks.needsReconciliation([taskId]);
      const step = 'c'.repeat(64);
      const bridge = new ObserverMailboxBridge(tasks, async (path) => {
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: 1, lease_token: 'lease',
        } };
        if (path.endsWith('/task-attempts')) return { task_id: taskId, external_calls: 0,
          attempts: [{ model_step_id: step, identity: '2'.repeat(64), phase: 'completed',
            http_request_started_at: '2019-12-31T23:00:00Z', in_flight: false,
            http_request_deadline_at: '2020-01-01T00:00:00Z' }] };
        return {};
      });
      await bridge.tick();
      expect(tasks.getBusinessFailureCount(taskId, step)).toBe(0);
      expect(tasks.get(taskId)?.state).toBe('reconciliation');
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
        if (path.endsWith('/claim')) return { command: {
          command_id: COMMAND_ID, task_id: taskId, model_step_id: step,
          action: 'check', expected_version: 1, lease_token: 'lease',
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
});
