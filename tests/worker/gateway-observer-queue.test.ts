import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayObserverQueue } from '../../src/services/worker/GatewayObserverQueue.js';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

describe('durable gateway observer batches', () => {
  let db: Database, tasks: ObserverTaskStore, store: SessionStore, manager: any, config: any;
  let dir: string, session: number;
  beforeEach(() => {
    dir=mkdtempSync(join(tmpdir(),'cm-queue-test-'));
    writeFileSync(join(dir,'token'),'test-caller-token',{mode:0o600});
    db=new Database(join(dir,'test.sqlite3'));
    store=new SessionStore(db);
    tasks=new ObserverTaskStore(db);
    session=store.createSDKSession('source-session','project','user request');
    manager={getConnection:()=>db,getSessionStore:()=>store,getObserverTaskStore:()=>tasks,getCloudSync:()=>null};
    config={url:'http://127.0.0.1:39000',tokenFile:join(dir,'token'),maxItems:2,maxBytes:64000};
    ModeManager.getInstance().loadMode('code');
  });
  afterEach(() => {db.close();rmSync(dir,{recursive:true,force:true});});
  function add(n: number, extra: any={}) {
    return tasks.create({sessionDbId:session,contentSessionId:'source-session',sourceId:'tool-'+n,
      payload:JSON.stringify({tool_name:'Read',tool_input:'{"file_path":"/source.ts"}',tool_response:'fact '+n,prompt_number:1}),
      enqueuedAtEpoch:1700000000000+n,queueContext:{project:'project',userPrompt:'request'},...extra});
  }
  function batches(): any[] {return db.prepare('SELECT * FROM observer_queue_batches ORDER BY created_at,id').all() as any[];}
  function queue(fetcher: any=()=>{throw new Error('no network allowed');}) { return new GatewayObserverQueue(manager,config,fetcher); }
  function response(req: any, state='succeeded', stop='end_turn') {
    return Response.json({version:1,job:{request_key:req.headers['Idempotency-Key'],business_key:'claude_mem.observation',state,
      response:{model:'gateway-business-model',stop_reason:stop,content:[{type:'text',text:'<skip_summary reason="no durable facts"/>'}],usage:{input_tokens:5,output_tokens:2}}}});
  }
  it('persists source ownership atomically and never adopts old SDK rows', () => {
    const owned=add(1), legacy=add(2,{queueContext:undefined});
    expect(tasks.markStrandedQueuedForReconciliation()).toBe(1);
    expect(tasks.get(owned)?.state).toBe('queued');
    expect(tasks.get(legacy)?.state).toBe('reconciliation');
  });
  it('uses bounded independent batches from the same source session', () => {
    for(let n=1;n<=5;n++) add(n);
    const worker=queue();
    expect(worker.prepareBatch()).toBe(true);
    expect(worker.prepareBatch()).toBe(true);
    expect(worker.prepareBatch()).toBe(true);
    expect(worker.prepareBatch()).toBe(false);
    expect(batches().length).toBe(3);
    for(const batch of batches()) {
      const body=JSON.parse(batch.body);
      expect(body.messages.length).toBe(1);
      expect(body.messages[0].role).toBe('user');
      expect(Buffer.byteLength(batch.body)).toBeLessThanOrEqual(config.maxBytes);
      const count=(db.prepare('SELECT count(*) AS n FROM observer_queue_members WHERE batch_id=?').get(batch.id) as any).n;
      expect(count).toBeLessThanOrEqual(2);
    }
    const first=batches()[0].body;
    tasks.markStrandedQueuedForReconciliation();
    expect(batches()[0].body).toBe(first);
    expect(db.prepare("SELECT count(*) AS n FROM observer_tasks WHERE state='running'").get()).toEqual({n:5});
  });
  it('explicitly holds oversized input before any model request', () => {
    const id=add(1,{payload:JSON.stringify({tool_name:'Read',tool_input:'{}',tool_response:'x'.repeat(70000)})});
    expect(queue().prepareBatch()).toBe(true);
    expect(tasks.get(id)).toMatchObject({state:'failed',outcome:'batch_input_over_budget'});
    expect(batches()).toHaveLength(0);
  });
  it('reuses exact request identity after submission ambiguity and restart', async () => {
    add(1); const seen: any[]=[];
    const worker=queue(async (_url:any,req:any)=>{seen.push(req);throw new Error('connection lost');});
    worker.prepareBatch();
    await expect(worker.processBatch(batches()[0])).rejects.toThrow('connection lost');
    const restarted=queue(async (_url:any,req:any)=>{seen.push(req);return response(req,'queued');});
    await restarted.processBatch(batches()[0]);
    expect(seen[0].body).toBe(seen[1].body);
    expect(seen[0].headers['Idempotency-Key']).toBe(seen[1].headers['Idempotency-Key']);
    expect(batches()[0].state).toBe('pending');
  });
  it('commits business result and receipt together then acknowledges without another submit', async () => {
    const id=add(1); const paths:string[]=[];
    const worker=queue(async (url:any,req:any)=>{paths.push(url);return response(req);});
    worker.prepareBatch();
    await worker.processBatch(batches()[0]);
    expect(tasks.get(id)?.state).toBe('succeeded');
    expect(batches()[0].acknowledged).toBe(0);
    const restarted=queue(async(url:any,req:any)=>{paths.push(url);return Response.json({version:1});});
    await restarted.processBatch(batches()[0]);
    expect(batches()[0].acknowledged).toBe(1);
    expect(paths.map(p=>new URL(p).pathname)).toEqual(['/v1/queue/submit','/v1/queue/ack']);
  });
  it('never treats truncated output as business success', async () => {
    const id=add(1),worker=queue(async(_url:any,req:any)=>response(req,'succeeded','max_tokens'));
    worker.prepareBatch();await worker.processBatch(batches()[0]);
    expect(tasks.get(id)?.state).toBe('reconciliation');
    expect(batches()[0].receipt).toBeNull();
    expect(batches()[0].result).not.toBeNull();
  });
});
