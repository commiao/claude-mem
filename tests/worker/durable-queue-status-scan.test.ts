import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

/**
 * /api/processing-status runs getDurableQueueStatus on the worker's event loop,
 * and the kg-hub capture probe calls it every ~150 s. Its per-state ownership
 * count used to fetch every task row (payload included) to read the id it joins
 * on: 4.2–4.3 s per call at 41k tasks, stalling /api/health with it
 * (2026-10-22). Every observer_tasks step must be answered from an index alone.
 */
describe('durable queue status reads observer_tasks from indexes only', () => {
  let db: Database, store: SessionStore, tasks: ObserverTaskStore;
  const prior = process.env.CLAUDE_MEM_LLM_QUEUE_URL;
  beforeEach(() => {
    process.env.CLAUDE_MEM_LLM_QUEUE_URL = 'http://127.0.0.1:39000';
    db = new Database(':memory:');
    store = new SessionStore(db);
    tasks = new ObserverTaskStore(db);
  });
  afterEach(() => {
    db.close();
    if (prior === undefined) delete process.env.CLAUDE_MEM_LLM_QUEUE_URL; else process.env.CLAUDE_MEM_LLM_QUEUE_URL = prior;
  });

  it('never fetches task rows', () => {
    const session = store.createSDKSession('source-session', 'project', 'user request');
    for (let n = 0; n < 20; n++) tasks.create({ sessionDbId: session, contentSessionId: 'source-session', sourceId: 'tool-' + n,
      payload: JSON.stringify({ tool_response: 'x'.repeat(200) }), enqueuedAtEpoch: 1700000000000 + n,
      ...(n % 4 ? { queueContext: { project: 'project', userPrompt: 'request' } } : {}) });
    const seen: string[] = [], prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
    let status: any;
    try {
      status = new SessionManager({ getConnection: () => db, getSessionStore: () => store, getObserverTaskStore: () => tasks } as any)
        .getDurableQueueStatus();
    } finally { (db as any).prepare = prepare; }
    expect(status.tasks).toEqual(expect.arrayContaining([
      { state: 'queued', owner: 'gateway', count: 15 }, { state: 'queued', owner: 'legacy', count: 5 },
    ]));
    const touched = seen.filter(s => /observer_tasks/.test(s));
    expect(touched.length).toBeGreaterThan(0);
    for (const sql of touched) {
      const plan = (db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as { detail: string }[]).map(p => p.detail);
      // A step on observer_tasks (aliased `t`) that is not covering reads the row.
      const rowReads = plan.filter(d => /^(SCAN|SEARCH) (observer_tasks|t)\b/.test(d) && !/COVERING INDEX|INTEGER PRIMARY KEY/.test(d));
      expect({ sql, rowReads }).toEqual({ sql, rowReads: [] });
    }
  });
});
