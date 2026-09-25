import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';

describe('ObserverTaskStore', () => {
  it('preserves exact source and unresolved state across store reconstruction', () => {
    const db = new Database(':memory:');
    try {
      const first = new ObserverTaskStore(db);
      const source = {
        sessionDbId: 17,
        contentSessionId: 'session-a',
        sourceId: 'toolu_1',
        payload: JSON.stringify({ tool_input: 'complete input', tool_response: 'complete output' }),
      };
      const id = first.create(source);
      first.needsReconciliation([id]);

      const reopened = new ObserverTaskStore(db);
      expect(reopened.create(source)).toBe(id);
      expect(reopened.get(id)).toMatchObject({
        ...source,
        id,
        state: 'reconciliation',
        actualCalls: 0,
      });
      expect(reopened.hasUnresolved(17)).toBe(true);
      expect(() => reopened.create({ ...source, payload: 'changed' }))
        .toThrow('observer_task_source_payload_changed');
    } finally {
      db.close();
    }
  });

  it('rolls back a task success receipt when the enclosing business write fails', () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const id = tasks.create({
        sessionDbId: 3,
        contentSessionId: 'session-3',
        sourceId: 'toolu-3',
        payload: '{"tool":"Read"}',
      });
      expect(() => db.transaction(() => {
        tasks.recordPersistedOutcome([id], '{"observationIds":[9]}');
        throw new Error('business_store_failed');
      })()).toThrow('business_store_failed');
      expect(tasks.get(id)?.state).toBe('queued');
    } finally {
      db.close();
    }
  });
});
