import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { ObserverReconciliation, UNKNOWN_MODEL_STEP_ID } from '../../src/services/worker/ObserverReconciliation.js';

const stepId = 'a'.repeat(64);
const identity = 'b'.repeat(64);

function task() {
  const db = new Database(':memory:');
  const store = new ObserverTaskStore(db);
  const id = store.create({ sessionDbId: 4, contentSessionId: 'session-4', sourceId: 'toolu-4', payload: '{}' });
  store.needsReconciliation([id]);
  return { db, store, id };
}

describe('ObserverReconciliation', () => {
  it('counts witnessed provider admissions and does not treat query external_calls as model calls', async () => {
    const { db, store, id } = task();
    try {
      const fetcher = mock(async () => new Response(JSON.stringify({
        task_id: id,
        external_calls: 0,
        attempts: [{
          identity, model_step_id: stepId, phase: 'failed',
          provider_call_started: true, external_calls: 0,
        }],
      }), { status: 200 }));
      const result = await new ObserverReconciliation(store, fetcher as unknown as typeof fetch)
        .check(id, 'http://127.0.0.1:39001', 'local-key');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        task_id: id, model_step_id: stepId, failed_attempts: 1,
        business_state: 'reconciliation', retryable: false,
      });
      expect(store.get(id)?.actualCalls).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps absent evidence in the unknown-step bucket without authorizing replay', async () => {
    const { db, store, id } = task();
    try {
      const fetcher = mock(async () => new Response(JSON.stringify({ task_id: id, attempts: [] }), { status: 200 }));
      const result = await new ObserverReconciliation(store, fetcher as unknown as typeof fetch)
        .check(id, 'http://127.0.0.1:39001', 'local-key');
      expect(result[0]).toMatchObject({
        model_step_id: UNKNOWN_MODEL_STEP_ID,
        failed_attempts: 0,
        retryable: false,
        reason: 'no_exact_step_evidence',
      });
      expect(store.get(id)?.state).toBe('reconciliation');
    } finally {
      db.close();
    }
  });

  it('does not count an admitted call as terminal until gateway proves it is no longer in flight and timed out', async () => {
    const { db, store, id } = task();
    try {
      const gateway = (inFlight: boolean, deadlineAt: string) => ({
        task_id: id,
        attempts: [{ identity, model_step_id: stepId, phase: 'admitted',
          provider_call_started: true, in_flight: inFlight, deadline_at: deadlineAt }],
      });
      let response = gateway(true, new Date(Date.now() - 1000).toISOString());
      const fetcher = mock(async () => new Response(JSON.stringify(response), { status: 200 }));
      const checker = new ObserverReconciliation(store, fetcher as unknown as typeof fetch);
      expect((await checker.check(id, 'http://127.0.0.1:39001', 'key'))[0].reason)
        .toBe('model_call_state_unknown_or_in_flight');
      expect(store.get(id)?.actualCalls).toBe(0);
      response = gateway(false, new Date(Date.now() - 1000).toISOString());
      expect((await checker.check(id, 'http://127.0.0.1:39001', 'key'))[0].failed_attempts).toBe(1);
    } finally {
      db.close();
    }
  });
});
