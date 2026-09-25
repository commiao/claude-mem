import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';

export type ObserverTaskState = 'queued' | 'reconciliation' | 'retry_authorized' | 'succeeded' | 'skipped' | 'failed';

export interface ObserverTaskInput {
  sessionDbId: number;
  contentSessionId: string;
  sourceId: string | null;
  payload: string;
}

export interface ObserverTaskRow extends ObserverTaskInput {
  id: string;
  state: ObserverTaskState;
  actualCalls: number;
  version: number;
  outcome: string | null;
}

export interface RetryDecision {
  commandId: string;
  taskId: string;
  modelStepId: string;
  expectedVersion: number;
  verifiedStepCalls: number;
  /** True only after an authoritative gateway query proves no call remains in flight. */
  noInFlight: boolean;
}

export type RetryReservation =
  | { accepted: true; version: number; duplicate: boolean }
  | { accepted: false; reason: 'not_found' | 'version_conflict' | 'not_reconciling' | 'uncertain_calls' | 'exhausted' | 'in_flight' };

/** Durable source and state for observer work. The RAM message id is never an identity. */
export class ObserverTaskStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS observer_tasks (
      id TEXT PRIMARY KEY,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      source_id TEXT,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      actual_calls INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_db_id, source_id)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_observer_tasks_state ON observer_tasks(state, session_db_id)');
    const columns = db.prepare('PRAGMA table_info(observer_tasks)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'version')) {
      db.run('ALTER TABLE observer_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    }
    db.run(`CREATE TABLE IF NOT EXISTS observer_task_commands (
      command_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      model_step_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('check', 'retry')),
      state TEXT NOT NULL CHECK(state IN ('accepted', 'started', 'finished')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS observer_task_steps (
      task_id TEXT NOT NULL,
      model_step_id TEXT NOT NULL,
      actual_calls INTEGER NOT NULL DEFAULT 0 CHECK(actual_calls BETWEEN 0 AND 3),
      state TEXT NOT NULL DEFAULT 'reconciliation' CHECK(state IN ('reconciliation', 'succeeded', 'failed')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(task_id, model_step_id)
    )`);
  }

  create(input: ObserverTaskInput): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO observer_tasks
      (id, session_db_id, content_session_id, source_id, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_db_id, source_id) DO NOTHING`)
      .run(id, input.sessionDbId, input.contentSessionId, input.sourceId, input.payload);
    if (input.sourceId) {
      const row = this.db.prepare('SELECT id, payload FROM observer_tasks WHERE session_db_id = ? AND source_id = ?')
        .get(input.sessionDbId, input.sourceId) as { id: string; payload: string };
      if (row.payload !== input.payload) {
        throw new Error('observer_task_source_payload_changed');
      }
      return row.id;
    }
    return id;
  }

  get(id: string): ObserverTaskRow | null {
    const row = this.db.prepare(`SELECT id, session_db_id AS sessionDbId,
      content_session_id AS contentSessionId, source_id AS sourceId, payload,
      state, actual_calls AS actualCalls, version, outcome FROM observer_tasks WHERE id = ?`)
      .get(id) as ObserverTaskRow | undefined;
    return row ?? null;
  }

  needsReconciliation(ids: string[]): void {
    const update = this.db.prepare(`UPDATE observer_tasks SET state = 'reconciliation',
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'queued'`);
    this.db.transaction(() => { for (const id of ids) update.run(id); })();
  }

  recordPersistedOutcome(ids: string[], outcome: string): void {
    const update = this.db.prepare(`UPDATE observer_tasks SET state = 'succeeded', outcome = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state IN ('queued', 'reconciliation')`);
    this.db.transaction(() => { for (const id of ids) update.run(outcome, id); })();
  }

  recordSkipped(ids: string[], reason: string): void {
    const update = this.db.prepare(`UPDATE observer_tasks SET state = 'skipped', outcome = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'queued'`);
    this.db.transaction(() => { for (const id of ids) update.run(reason, id); })();
  }

  /** On restart, no in-RAM claim can prove whether an old queued row was sent. */
  markStrandedQueuedForReconciliation(): number {
    const result = this.db.prepare(`UPDATE observer_tasks SET state = 'reconciliation',
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE state IN ('queued', 'retry_authorized')`).run();
    return result.changes;
  }

  /** Persist an authoritative gateway witness for one stable business step. */
  recordStepWitness(taskId: string, modelStepId: string, actualCalls: number): void {
    if (!modelStepId || !Number.isInteger(actualCalls) || actualCalls < 0) {
      throw new Error('invalid_model_step_witness');
    }
    this.db.transaction(() => {
      if (!this.get(taskId)) throw new Error('observer_task_not_found');
      const row = this.db.prepare(`SELECT actual_calls AS actualCalls, state
        FROM observer_task_steps WHERE task_id = ? AND model_step_id = ?`)
        .get(taskId, modelStepId) as { actualCalls: number; state: string } | undefined;
      if (row && actualCalls < row.actualCalls) throw new Error('model_step_call_count_regressed');
      if (actualCalls > 3) {
        this.db.prepare(`INSERT INTO observer_task_steps
          (task_id, model_step_id, actual_calls, state) VALUES (?, ?, 3, 'failed')
          ON CONFLICT(task_id, model_step_id) DO UPDATE SET
          actual_calls = 3, state = 'failed', updated_at = CURRENT_TIMESTAMP`)
          .run(taskId, modelStepId);
        this.db.prepare(`UPDATE observer_tasks SET state = 'failed', version = version + 1,
          actual_calls = 3, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND state = 'reconciliation'`).run(taskId);
        return;
      }
      const state = actualCalls >= 3 ? 'failed' : row?.state === 'succeeded' ? 'succeeded' : 'reconciliation';
      this.db.prepare(`INSERT INTO observer_task_steps
        (task_id, model_step_id, actual_calls, state) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id, model_step_id) DO UPDATE SET
        actual_calls = excluded.actual_calls, state = excluded.state,
        updated_at = CURRENT_TIMESTAMP`).run(taskId, modelStepId, actualCalls, state);
      if (state === 'failed') {
        this.db.prepare(`UPDATE observer_tasks SET state = 'failed', version = version + 1,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'reconciliation'`).run(taskId);
      }
      const aggregate = this.db.prepare(`SELECT COALESCE(SUM(actual_calls), 0) AS calls
        FROM observer_task_steps WHERE task_id = ?`).get(taskId) as { calls: number };
      this.applyVerifiedCallCount(taskId, aggregate.calls);
    })();
  }

  /** Store the gateway's witnessed model-call count. Unknown evidence never enters here. */
  applyVerifiedCallCount(taskId: string, actualCalls: number): ObserverTaskRow | null {
    if (!Number.isInteger(actualCalls) || actualCalls < 0) throw new Error('invalid_actual_call_count');
    this.db.prepare(`UPDATE observer_tasks SET actual_calls = ?,
      state = CASE WHEN ? >= 3 AND state = 'reconciliation' THEN 'failed' ELSE state END,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state IN ('reconciliation', 'failed') AND actual_calls != ?`)
      .run(Math.min(actualCalls, 3), actualCalls, taskId, Math.min(actualCalls, 3));
    return this.get(taskId);
  }

  reserveManualRetry(input: RetryDecision): RetryReservation {
    return this.db.transaction((): RetryReservation => {
      const prior = this.db.prepare('SELECT task_id AS taskId, model_step_id AS modelStepId, action, state FROM observer_task_commands WHERE command_id = ?')
        .get(input.commandId) as { taskId: string; modelStepId: string; action: string; state: string } | undefined;
      if (prior) {
        if (prior.taskId !== input.taskId || prior.modelStepId !== input.modelStepId || prior.action !== 'retry') {
          return { accepted: false, reason: 'version_conflict' };
        }
        const task = this.get(input.taskId);
        return task ? { accepted: true, version: task.version, duplicate: true } : { accepted: false, reason: 'not_found' };
      }
      const task = this.get(input.taskId);
      if (!task) return { accepted: false, reason: 'not_found' };
      if (task.version !== input.expectedVersion) return { accepted: false, reason: 'version_conflict' };
      if (task.state !== 'reconciliation') return { accepted: false, reason: 'not_reconciling' };
      if (!input.modelStepId || !Number.isInteger(input.verifiedStepCalls) || input.verifiedStepCalls < 0) {
        return { accepted: false, reason: 'uncertain_calls' };
      }
      const step = this.db.prepare(`SELECT actual_calls AS actualCalls, state
        FROM observer_task_steps WHERE task_id = ? AND model_step_id = ?`)
        .get(input.taskId, input.modelStepId) as { actualCalls: number; state: string } | undefined;
      if (!step || step.actualCalls !== input.verifiedStepCalls || step.state !== 'reconciliation') {
        return { accepted: false, reason: 'uncertain_calls' };
      }
      if (!input.noInFlight) return { accepted: false, reason: 'in_flight' };
      if (input.verifiedStepCalls >= 3) return { accepted: false, reason: 'exhausted' };
      // Preserve the global task ceiling as well as the per-step ceiling.
      // A model SDK may issue several distinct internal calls for one task.
      if (task.actualCalls >= 3) return { accepted: false, reason: 'exhausted' };
      this.db.prepare(`UPDATE observer_tasks SET state = 'retry_authorized',
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'reconciliation' AND version = ?`)
        .run(input.taskId, input.expectedVersion);
      this.db.prepare(`INSERT INTO observer_task_commands (command_id, task_id, model_step_id, action, state)
        VALUES (?, ?, ?, 'retry', 'accepted')`).run(input.commandId, input.taskId, input.modelStepId);
      return { accepted: true, version: input.expectedVersion + 1, duplicate: false };
    })();
  }

  startManualRetry(commandId: string, taskId: string): boolean {
    return this.db.transaction(() => {
      const command = this.db.prepare(`UPDATE observer_task_commands SET state = 'started',
        updated_at = CURRENT_TIMESTAMP WHERE command_id = ? AND task_id = ?
        AND action = 'retry' AND state = 'accepted'`).run(commandId, taskId);
      if (command.changes !== 1) return false;
      const task = this.db.prepare(`UPDATE observer_tasks SET state = 'queued',
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'retry_authorized'`).run(taskId);
      if (task.changes !== 1) throw new Error('manual_retry_task_state_changed');
      return true;
    })();
  }

  hasUnresolved(sessionDbId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM observer_tasks
      WHERE session_db_id = ? AND state = 'reconciliation' LIMIT 1`).get(sessionDbId);
  }

  list(state: ObserverTaskState, limit = 100): ObserverTaskRow[] {
    return this.db.prepare(`SELECT id, session_db_id AS sessionDbId,
      content_session_id AS contentSessionId, source_id AS sourceId, payload,
      state, actual_calls AS actualCalls, version, outcome FROM observer_tasks
      WHERE state = ? ORDER BY created_at, id LIMIT ?`).all(state, Math.min(Math.max(limit, 1), 500)) as ObserverTaskRow[];
  }
}
