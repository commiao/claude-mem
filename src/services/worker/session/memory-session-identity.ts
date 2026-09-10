import type { ActiveSession } from '../../worker-types.js';
import type { SessionStore } from '../../sqlite/SessionStore.js';
import { logger } from '../../../utils/logger.js';

type MemorySessionStore = Pick<SessionStore,
  'ensureMemorySessionIdRegistered' | 'getSessionById'>;

/**
 * Keep the database identity used by observations and summaries stable across
 * fresh observer processes.
 *
 * Claude observer processes are started with --no-session-persistence, so a
 * session_id emitted by a replacement process cannot be resumed. In contrast,
 * memory_session_id is the non-null FK parent of already-stored observations
 * and summaries. Replacing that parent id would cascade historical rows to a
 * different observer process; clearing it would violate their NOT NULL
 * constraints. The first provider id establishes the durable storage identity.
 */
export function registerProviderMemorySessionId(
  session: ActiveSession,
  providerMemorySessionId: string,
  sessionStore: MemorySessionStore,
): 'captured' | 'preserved' | 'unchanged' {
  if (!session.memorySessionId) {
    session.memorySessionId = providerMemorySessionId;
    sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, providerMemorySessionId);

    const verification = sessionStore.getSessionById(session.sessionDbId);
    const dbVerified = verification?.memory_session_id === providerMemorySessionId;
    logger.info('SESSION', `MEMORY_ID_CAPTURED | sessionDbId=${session.sessionDbId} | memorySessionId=${providerMemorySessionId} | dbVerified=${dbVerified}`, {
      sessionId: session.sessionDbId,
      memorySessionId: providerMemorySessionId,
      previousId: null,
    });
    if (!dbVerified) {
      logger.error('SESSION', `MEMORY_ID_MISMATCH | sessionDbId=${session.sessionDbId} | expected=${providerMemorySessionId} | got=${verification?.memory_session_id}`, {
        sessionId: session.sessionDbId,
      });
    }
    return 'captured';
  }

  if (session.memorySessionId === providerMemorySessionId) {
    return 'unchanged';
  }

  logger.info('SESSION', 'Provider started a fresh no-persistence session; retaining the established storage identity', {
    sessionId: session.sessionDbId,
    storageMemorySessionId: session.memorySessionId,
    providerMemorySessionId,
  });
  return 'preserved';
}
