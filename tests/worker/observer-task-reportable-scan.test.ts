import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

/**
 * ObserverMailboxBridge reads the next 20 reportable tasks every 10 s on the
 * worker's event loop. Planned through idx_observer_tasks_state the read matched
 * every task, loaded each payload and sorted them all: 267 MB at 40k tasks, and
 * /api/health stalled 0.5–3.5 s on every tick (2026-10-22).
 */
describe('listReportableAfter walks the primary key', () => {
  let db: Database, tasks: ObserverTaskStore, session: number;
  beforeEach(() => {
    db = new Database(':memory:');
    const store = new SessionStore(db);
    tasks = new ObserverTaskStore(db);
    session = store.createSDKSession('source-session', 'project', 'user request');
  });
  afterEach(() => db.close());

  function add(n: number): string {
    return tasks.create({ sessionDbId: session, contentSessionId: 'source-session', sourceId: 'tool-' + n,
      payload: JSON.stringify({ tool_name: 'Read', tool_response: 'x'.repeat(100) }), enqueuedAtEpoch: 1700000000000 + n,
      queueContext: { project: 'project', userPrompt: 'request' } });
  }

  it('is answered by a bounded primary-key range, not a state scan and sort', () => {
    // No ANALYZE: production has no sqlite_stat1, so the planner works from its
    // defaults, which is what chose the state index there.
    for (let n = 0; n < 50; n++) add(n);
    const seen: string[] = [], prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
    try { tasks.listReportableAfter('', 20); } finally { (db as any).prepare = prepare; }
    const sql = seen.find(s => /FROM observer_tasks/.test(s))!;
    const plan = (db.prepare('EXPLAIN QUERY PLAN ' + sql).all('', 20) as { detail: string }[]).map(p => p.detail);
    expect(plan.some(d => /SEARCH observer_tasks USING INDEX sqlite_autoindex_observer_tasks_1 \(id>\?\)/.test(d))).toBe(true);
    expect(plan.filter(d => /idx_observer_tasks_state|TEMP B-TREE|^SCAN observer_tasks/.test(d))).toEqual([]);
  });

  it('keeps its result: reportable states after the cursor, in id order, bounded', () => {
    const ids = Array.from({ length: 30 }, (_, n) => add(n)).sort();
    db.prepare("UPDATE observer_tasks SET state='retry_authorized' WHERE id=?").run(ids[3]);
    const first = tasks.listReportableAfter('', 20).map(r => r.id);
    expect(first).toEqual(ids.filter((_, i) => i !== 3).slice(0, 20));
    const next = tasks.listReportableAfter(first[first.length - 1], 20).map(r => r.id);
    expect(next).toEqual(ids.filter((_, i) => i !== 3).slice(20));
  });
});
