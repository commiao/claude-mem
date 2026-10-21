import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayObserverQueue, initializeQueueTables } from '../../src/services/worker/GatewayObserverQueue.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

/**
 * The poll loop runs every 2 s on the worker's event loop, and bun:sqlite is
 * synchronous. A batch row stores its request body before its state columns, so
 * a scan that filters observer_queue_batches on state reads every body: at 17k
 * batches (392 MB of bodies) each scan took ~3 s and /api/health timed out in
 * 28–53% of probes (2026-10-19..21). Every query the loop issues must be
 * answered from an index.
 */
describe('gateway observer queue poll loop never scans batch bodies', () => {
  let db: Database, dir: string, manager: any, tasks: ObserverTaskStore, store: SessionStore;
  beforeEach(() => {
    dir=mkdtempSync(join(tmpdir(),'cm-queue-scan-'));
    writeFileSync(join(dir,'token'),'test-caller-token',{mode:0o600});
    db=new Database(join(dir,'test.sqlite3'));
    store=new SessionStore(db);
    tasks=new ObserverTaskStore(db);
    manager={getConnection:()=>db,getSessionStore:()=>store,getObserverTaskStore:()=>tasks,getCloudSync:()=>null};
    ModeManager.getInstance().loadMode('code');
  });
  afterEach(() => {db.close();rmSync(dir,{recursive:true,force:true});});

  /** SQL text of every statement prepared while fn runs. */
  async function captureSql(fn: () => Promise<unknown> | unknown): Promise<string[]> {
    const seen: string[] = [], prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
    try { await fn(); } finally { (db as any).prepare = prepare; }
    return [...new Set(seen)];
  }
  /** Plan steps that walk observer_queue_batches row by row. */
  function batchScans(sql: string): string[] {
    const args = new Array((sql.match(/\?/g) || []).length).fill(0);
    const plan = db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args) as {detail:string}[];
    return plan.map(p=>p.detail).filter(d=>/^SCAN observer_queue_batches\b/.test(d) && !/COVERING INDEX/.test(d));
  }

  it('the cycle and the status read use indexes only', async () => {
    const session=store.createSDKSession('source-session','project','user request');
    for (let n=0;n<3;n++) tasks.create({sessionDbId:session,contentSessionId:'source-session',sourceId:'tool-'+n,
      payload:JSON.stringify({tool_name:'Read',tool_input:'{}',tool_response:'fact '+n,prompt_number:1}),
      enqueuedAtEpoch:1700000000000+n,queueContext:{project:'project',userPrompt:'request'}});
    const worker=new GatewayObserverQueue(manager,
      {url:'http://127.0.0.1:39000',tokenFile:join(dir,'token'),maxItems:1,maxBytes:64000,submitsPerMinute:60},
      (async (_url: any, req: any) => {
        const key=req.headers['Idempotency-Key'] || JSON.parse(req.body).idempotency_key;
        return Response.json({version:1,job:{request_key:key,business_key:'claude_mem.observation',state:'queued'}});
      }) as any);
    const sql=await captureSql(async () => {
      await worker.cycle(); await worker.cycle();
      const prior=process.env.CLAUDE_MEM_LLM_QUEUE_URL;
      process.env.CLAUDE_MEM_LLM_QUEUE_URL='http://127.0.0.1:39000';
      try { new SessionManager(manager).getDurableQueueStatus(); }
      finally { if (prior===undefined) delete process.env.CLAUDE_MEM_LLM_QUEUE_URL; else process.env.CLAUDE_MEM_LLM_QUEUE_URL=prior; }
    });
    const touched=sql.filter(s=>/observer_queue_batches/.test(s) && /^\s*SELECT/i.test(s));
    expect(touched.length).toBeGreaterThan(2);
    for (const s of touched) expect({sql:s,scans:batchScans(s)}).toEqual({sql:s,scans:[]});
  });

  it('adds the indexes to a database created before them', () => {
    const old=new Database(':memory:');
    old.run(`CREATE TABLE observer_queue_batches (id TEXT PRIMARY KEY, session_db_id INTEGER NOT NULL, body TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', result TEXT, receipt TEXT, acknowledged INTEGER NOT NULL DEFAULT 0,
      error TEXT, created_at INTEGER NOT NULL)`);
    initializeQueueTables(old as any);
    const names=(old.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map(r=>r.name);
    old.close();
    expect(names).toEqual(expect.arrayContaining(['idx_observer_queue_batches_state','idx_observer_queue_batches_unacked','idx_observer_queue_members_batch']));
  });
});
