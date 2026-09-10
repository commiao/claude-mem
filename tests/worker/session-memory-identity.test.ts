import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { registerProviderMemorySessionId } from '../../src/services/worker/session/memory-session-identity.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function summary() {
  return {
    request: 'Preserve this summary',
    investigated: 'Check lifecycle',
    learned: 'The storage id is an FK parent',
    completed: 'Stored before recycle',
    next_steps: 'Do not rewrite its parent',
    notes: null,
  };
}

describe('observer memory session storage identity', () => {
  const stores: SessionStore[] = [];

  afterEach(() => {
    while (stores.length > 0) stores.pop()?.close();
  });

  it('keeps an existing summary and observation bound to the original identity across worker rehydration and a fresh provider process', () => {
    const store = new SessionStore(':memory:');
    stores.push(store);
    const sessionDbId = store.createSDKSession('content-recycle', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'stored-memory-id');
    store.storeObservation('stored-memory-id', 'project', {
      type: 'discovery', title: 'Old observation', subtitle: null, facts: [], narrative: 'old',
      concepts: [], files_read: [], files_modified: [],
    });
    store.storeSummary('stored-memory-id', 'project', summary());

    const dbManager = {
      getSessionById: (id: number) => store.getSessionById(id),
      getSessionStore: () => store,
    } as unknown as DatabaseManager;
    const session = new SessionManager(dbManager).initializeSession(sessionDbId);
    const updateMemorySessionId = spyOn(store, 'updateMemorySessionId');

    // A worker restart must hydrate the existing FK identity, while the
    // provider still starts a fresh no-persistence process (no resume token).
    expect(session.memorySessionId).toBe('stored-memory-id');
    expect(registerProviderMemorySessionId(session, 'fresh-provider-id', store)).toBe('preserved');

    expect(session.memorySessionId).toBe('stored-memory-id');
    expect(store.getSessionById(sessionDbId)?.memory_session_id).toBe('stored-memory-id');
    expect(store.getObservationsForSession('stored-memory-id')).toHaveLength(1);
    expect(store.getSummaryForSession('stored-memory-id')?.request).toBe('Preserve this summary');
    expect(store.getObservationsForSession('fresh-provider-id')).toHaveLength(0);
    expect(store.getSummaryForSession('fresh-provider-id')).toBeNull();
    // This is the operation that made overflow recycle fail: setting the FK
    // parent to null cascaded into summaries.memory_session_id (NOT NULL).
    expect(updateMemorySessionId).not.toHaveBeenCalled();
  });

  it('registers the first real provider id for a session that has no storage identity yet', () => {
    const store = new SessionStore(':memory:');
    stores.push(store);
    const sessionDbId = store.createSDKSession('content-first-provider-id', 'project', 'prompt');
    const session = new SessionManager({
      getSessionById: (id: number) => store.getSessionById(id),
      getSessionStore: () => store,
    } as unknown as DatabaseManager).initializeSession(sessionDbId);

    expect(registerProviderMemorySessionId(session, 'first-provider-id', store)).toBe('captured');
    expect(session.memorySessionId).toBe('first-provider-id');
    expect(store.getSessionById(sessionDbId)?.memory_session_id).toBe('first-provider-id');
  });
});
