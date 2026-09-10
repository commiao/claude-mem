import type { Database } from 'bun:sqlite';

/** Completion cursor, not an input queue. No tool input/output is copied here. */
export class RecoveryLedger {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS observation_receipts (
      content_session_id TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('stored', 'skipped')),
      completed_at INTEGER NOT NULL,
      PRIMARY KEY(content_session_id, tool_use_id)
    )`);
  }

  has(sessionId: string, toolId: string): boolean {
    return !!this.db.query('SELECT 1 FROM observation_receipts WHERE content_session_id=? AND tool_use_id=?').get(sessionId, toolId);
  }

  /** Nested SQLite transactions use savepoints: output and receipts commit together. */
  commit<T>(sessionId: string, toolIds: string[], outcome: 'stored' | 'skipped', store: () => T): T {
    return this.db.transaction(() => {
      const result = store();
      const insert = this.db.query('INSERT OR IGNORE INTO observation_receipts VALUES (?, ?, ?, ?)');
      for (const id of new Set(toolIds)) insert.run(sessionId, id, outcome, Date.now());
      if (this.db.query("SELECT 1 FROM sqlite_master WHERE name='deferred_observations'").get()) {
        for (const id of new Set(toolIds)) this.db.query('DELETE FROM deferred_observations WHERE content_session_id=? AND tool_use_id=?').run(sessionId, id);
      }
      return result;
    })();
  }
}

export function completeObservationBatch<T>(
  db: Database, sessionId: string,
  messages: ReadonlyArray<{ type: string; toolUseId?: string }>,
  outcome: 'stored' | 'skipped', store: () => T,
): T {
  const ids = messages.filter(m => m.type === 'observation' && m.toolUseId).map(m => m.toolUseId!);
  // Legacy inputs without stable IDs remain outside the recovery guarantee.
  if (!ids.length) return store();
  return new RecoveryLedger(db).commit(sessionId, ids, outcome, store);
}
