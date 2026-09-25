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

  it('accepts one manual retry command with compare-and-swap and never starts it twice', () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const id = tasks.create({ sessionDbId: 5, contentSessionId: 's5', sourceId: 'toolu5', payload: '{}' });
      tasks.needsReconciliation([id]);
      const command = {
        commandId: 'command-5', taskId: id, modelStepId: 'step-5', expectedVersion: 2,
        verifiedStepCalls: 1, noInFlight: true,
      };
      tasks.recordStepWitness(id, command.modelStepId, 1);
      expect(tasks.reserveManualRetry({ ...command, noInFlight: false }))
        .toEqual({ accepted: false, reason: 'in_flight' });
      expect(tasks.reserveManualRetry(command)).toEqual({ accepted: true, version: 3, duplicate: false });
      expect(tasks.reserveManualRetry(command)).toEqual({ accepted: true, version: 3, duplicate: true });
      expect(tasks.startManualRetry(command.commandId, id)).toBe(true);
      expect(tasks.startManualRetry(command.commandId, id)).toBe(false);
      expect(tasks.get(id)).toMatchObject({ state: 'queued', actualCalls: 1, version: 4 });
      expect(tasks.markStrandedQueuedForReconciliation()).toBe(1);
      expect(tasks.get(id)?.state).toBe('reconciliation');
    } finally {
      db.close();
    }
  });

  it('marks a failed model step terminal after three witnessed calls', () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const id = tasks.create({ sessionDbId: 7, contentSessionId: 's7', sourceId: 'toolu7', payload: '{}' });
      tasks.needsReconciliation([id]);
      tasks.recordStepWitness(id, 'step-a', 3);
      expect(tasks.get(id)?.state).toBe('failed');
      expect(() => tasks.recordStepWitness(id, 'step-a', 2)).toThrow('model_step_call_count_regressed');
      tasks.recordStepWitness(id, 'step-b', 1);
      expect(db.prepare('SELECT actual_calls FROM observer_task_steps WHERE task_id = ? AND model_step_id = ?')
        .get(id, 'step-b')).toEqual({ actual_calls: 1 });
    } finally {
      db.close();
    }
  });

  it('keeps the three-call task ceiling when calls span different model steps', () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const id = tasks.create({ sessionDbId: 8, contentSessionId: 's8', sourceId: 'toolu8', payload: '{}' });
      tasks.needsReconciliation([id]);
      tasks.recordStepWitness(id, 'step-one', 2);
      expect(tasks.get(id)).toMatchObject({ actualCalls: 2, state: 'reconciliation' });
      tasks.recordStepWitness(id, 'step-two', 1);
      expect(tasks.get(id)).toMatchObject({ actualCalls: 3, state: 'failed' });
    } finally {
      db.close();
    }
  });

  it('replays a completed read-only check command without running it again', () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const id = tasks.create({ sessionDbId: 9, contentSessionId: 's9', sourceId: 'toolu9', payload: '{}' });
      expect(tasks.beginCheckCommand('check-9', id, '0'.repeat(64)))
        .toMatchObject({ duplicate: false, finished: false });
      tasks.finishCheckCommand('check-9', id, 'reconciliation', 1, 'no_exact_step_evidence');
      expect(tasks.beginCheckCommand('check-9', id, '0'.repeat(64))).toEqual({
        duplicate: true, finished: true, resultState: 'reconciliation',
        resultVersion: 1, resultReason: 'no_exact_step_evidence',
      });
      expect(() => tasks.beginCheckCommand('check-9', 'different-task', '0'.repeat(64)))
        .toThrow('observer_command_identity_conflict');
    } finally {
      db.close();
    }
  });

  it('makes the third expired business attempt terminal only for the same exact step', () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const id = tasks.create({ sessionDbId: 10, contentSessionId: 's10', sourceId: 'toolu10', payload: '{}' });
      tasks.needsReconciliation([id]);
      const first = 'a'.repeat(64);
      const second = 'b'.repeat(64);
      expect(tasks.recordExpiredBusinessAttempt(id, first, '1'.repeat(64))).toBe(1);
      expect(tasks.recordExpiredBusinessAttempt(id, first, '1'.repeat(64))).toBe(1);
      expect(tasks.recordExpiredBusinessAttempt(id, second, '2'.repeat(64))).toBe(1);
      expect(tasks.get(id)?.state).toBe('reconciliation');
      expect(tasks.recordExpiredBusinessAttempt(id, first, '3'.repeat(64))).toBe(2);
      expect(tasks.get(id)?.state).toBe('reconciliation');
      expect(tasks.recordExpiredBusinessAttempt(id, first, '4'.repeat(64))).toBe(3);
      expect(tasks.get(id)?.state).toBe('failed');
    } finally { db.close(); }
  });

  it('does not record timeout failures while the business task is still queued', () => {
    const db = new Database(':memory:');
    try {
      const tasks = new ObserverTaskStore(db);
      const id = tasks.create({ sessionDbId: 11, contentSessionId: 's11', sourceId: 'toolu11', payload: '{}' });
      expect(tasks.recordExpiredBusinessAttempt(id, 'a'.repeat(64), 'b'.repeat(64))).toBe(0);
      expect(tasks.getBusinessFailureCount(id, 'a'.repeat(64))).toBe(0);
    } finally { db.close(); }
  });
});
