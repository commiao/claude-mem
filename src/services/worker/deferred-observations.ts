import { RecoveryLedger } from './RecoveryLedger.js';
import type { Database } from 'bun:sqlite';
import type { ActiveSession, PendingMessageWithId } from '../worker-types.js';
import type { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';

export function initializeDeferredObservations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS deferred_observations (
    content_session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
    reason TEXT NOT NULL, payload TEXT NOT NULL, deferred_at INTEGER NOT NULL,
    PRIMARY KEY(content_session_id, tool_use_id))`);
}
export function isObservationDeferred(db: Database, sessionId: string, toolId: string): boolean {
  initializeDeferredObservations(db);
  return !!db.query('SELECT 1 FROM deferred_observations WHERE content_session_id=? AND tool_use_id=?').get(sessionId, toolId);
}
/** Persist the complete original before removing ONLY this claim. No completion
 * receipt, automatic retry, or cancellation of the main observer is involved. */
export function deferObservation(db: Database, session: ActiveSession, manager: SessionManager,
  message: PendingMessageWithId, reason: string): void {
  initializeDeferredObservations(db);
  const identity = message.toolUseId ?? `buffer:${session.sessionDbId}:${message._persistentId}:${message._originalTimestamp}`;
  db.query(`INSERT INTO deferred_observations VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(content_session_id,tool_use_id) DO UPDATE SET reason=excluded.reason`).run(
    session.contentSessionId, identity, reason, JSON.stringify(message), Date.now());
  session.claimedMessageIds = session.claimedMessageIds.filter(id => id !== message._persistentId);
  manager.getMessageBuffer().confirm(message._persistentId);
  logger.error('SDK', 'Observation deferred for explicit recovery; original payload retained', {
    sessionId: session.sessionDbId, toolUseId: identity, reason,
  });
}

/** Explicit operator action after addressing the recorded cause. Keep the
 * durable hold until a completion receipt commits, including across crashes. */
export function retryDeferredObservation(db: Database, session: ActiveSession,
  manager: SessionManager, identity: string): number {
  initializeDeferredObservations(db);
  if (new RecoveryLedger(db).has(session.contentSessionId, identity)) return 0;
  const row = db.query('SELECT payload FROM deferred_observations WHERE content_session_id=? AND tool_use_id=?')
    .get(session.contentSessionId, identity) as { payload: string } | null;
  if (!row) throw new Error('Deferred observation not found');
  const message = JSON.parse(row.payload) as PendingMessageWithId;
  // Give legacy messages the persisted fallback identity for retry dedup/receipt.
  message.toolUseId ??= identity;
  return manager.getMessageBuffer().restoreDeferred(session.sessionDbId, message);
}
