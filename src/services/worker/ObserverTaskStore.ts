import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';

export type ObserverTaskState = 'queued' | 'reconciliation' | 'succeeded' | 'skipped' | 'failed';

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
  outcome: string | null;
}

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
      actual_calls INTEGER NOT NULL DEFAULT 0 CHECK(actual_calls BETWEEN 0 AND 3),
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_db_id, source_id)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_observer_tasks_state ON observer_tasks(state, session_db_id)');
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
      state, actual_calls AS actualCalls, outcome FROM observer_tasks WHERE id = ?`)
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
      updated_at = CURRENT_TIMESTAMP WHERE state = 'queued'`).run();
    return result.changes;
  }

  hasUnresolved(sessionDbId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM observer_tasks
      WHERE session_db_id = ? AND state = 'reconciliation' LIMIT 1`).get(sessionDbId);
  }

  list(state: ObserverTaskState, limit = 100): ObserverTaskRow[] {
    return this.db.prepare(`SELECT id, session_db_id AS sessionDbId,
      content_session_id AS contentSessionId, source_id AS sourceId, payload,
      state, actual_calls AS actualCalls, outcome FROM observer_tasks
      WHERE state = ? ORDER BY created_at, id LIMIT ?`).all(state, Math.min(Math.max(limit, 1), 500)) as ObserverTaskRow[];
  }
}
