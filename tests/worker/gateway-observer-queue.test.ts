import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayObserverQueue } from '../../src/services/worker/GatewayObserverQueue.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
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
    config={url:'http://127.0.0.1:39000',tokenFile:join(dir,'token'),maxItems:2,maxBytes:64000,submitsPerMinute:600};
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
    return Response.json({version:1,job:{request_key:req.headers['Idempotency-Key'] || JSON.parse(req.body).idempotency_key,business_key:'claude_mem.observation',state,
      response:{model:'gateway-business-model',stop_reason:stop,content:[{type:'text',text:'<skip_summary reason="no durable facts"/>'}],usage:{input_tokens:5,output_tokens:2}}}});
  }
  it('rereads the managed caller source after token rotation', async () => {
    add(1);config.tokenEnv=true;
    const seen:string[]=[];
    const worker=queue(async (_url:any,req:any)=>{seen.push(req.headers.Authorization);return response(req,'queued');});
    worker.prepareBatch();
    for(const token of ['first-caller','rotated-caller']) {
      writeFileSync(config.tokenFile, `ANTHROPIC_AUTH_TOKEN="${token}"\nANTHROPIC_API_KEY="${token}"\n`);
      await worker.processBatch(batches()[0]);
    }
    expect(seen).toEqual(['Bearer first-caller','Bearer rotated-caller']);
  });
  it('persists source ownership atomically and never adopts old SDK rows', () => {
    const owned=add(1), legacy=add(2,{queueContext:undefined});
    expect(tasks.markStrandedQueuedForReconciliation()).toBe(1);
    expect(tasks.get(owned)?.state).toBe('queued');
    expect(tasks.get(legacy)?.state).toBe('reconciliation');
  });
  it('never routes queue-owned input into the SDK when queue configuration is removed', async () => {
    const id=add(1);
    const sessions=new SessionManager(manager);
    const prior=process.env.CLAUDE_MEM_LLM_QUEUE_URL;
    delete process.env.CLAUDE_MEM_LLM_QUEUE_URL;
    try {
      expect(() => sessions.queueObservation(session, {recoveryTaskId:id} as any))
        .toThrow('gateway_owned_task_requires_queue_runtime');
      expect(sessions.getMessageBuffer().getPendingCount(session)).toBe(0);
    } finally {
      if(prior!==undefined) process.env.CLAUDE_MEM_LLM_QUEUE_URL=prior;
    }
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
  it('polls past the first 64 unfinished batches without starving later work', async () => {
    config.maxItems=1;
    for(let i=0;i<65;i++) add(i);
    const seen=new Set<string>();
    const worker=queue(async (_url:any,req:any)=>{
      const key=req.headers['Idempotency-Key'] || JSON.parse(req.body).idempotency_key;
      seen.add(key);
      return Response.json({version:1,job:{request_key:key,business_key:'claude_mem.observation',state:'queued'}});
    });
    while(worker.prepareBatch()) {}
    await worker.cycle();expect(seen.size).toBe(64);
    await worker.cycle();expect(seen.size).toBe(65);
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
    expect(batches()[0].state).toBe('submitted');
  });
  it('commits business result and receipt together then acknowledges without another submit', async () => {
    const id=add(1); const paths:string[]=[];
    const worker=queue(async (url:any,req:any)=>{paths.push(url);return response(req);});
    worker.prepareBatch();
    await worker.processBatch(batches()[0]);
    expect(tasks.get(id)?.state).toBe('succeeded');
    expect(batches()[0].acknowledged).toBe(0);
    const restarted=queue(async(url:any,req:any)=>{paths.push(url);const payload=JSON.parse(req.body);return Response.json({version:1,job:{request_key:payload.idempotency_key,business_key:payload.business_key,business_receipt:{reference:payload.receipt.reference,state:payload.receipt.state}}});});
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
  it('records a source-quality rejection before creating any payable batch and retains the raw source', async () => {
    const id=add(71,{payload:JSON.stringify({tool_name:'mcp__ccd_turn__update_plan',
      tool_input:{items:[{content:'Fix cache',status:'pending'}]},tool_response:'Plan shown',prompt_number:1})});
    const worker=queue(async(_url:any,req:any)=>{
      const result=await response(req).json();
      result.job.response.content[0].text='<observation><type>discovery</type><title>Cache plan started</title><facts><fact>Work is planned</fact></facts></observation>';
      return Response.json(result);
    });
    worker.prepareBatch();
    const outcome=JSON.parse(tasks.get(id)!.outcome!);
    expect(outcome).toEqual({phase:'before_model',reason:'plan_bookkeeping_only',policyVersion:'source-quality-v1',externalCalls:0});
    expect(tasks.get(id)?.state).toBe('skipped');
    expect(tasks.get(id)?.payload).toContain('Fix cache');
    expect(batches()).toHaveLength(0);
    expect((db.prepare('SELECT count(*) AS n FROM observations').get() as any).n).toBe(0);
  });
  it('keeps mixed plan/live batches', () => {
    add(81,{payload:JSON.stringify({tool_name:'update_plan',tool_input:{items:[]},tool_response:'Plan shown',prompt_number:1})});
    add(82);
    const worker=queue();
    expect(worker.prepareBatch()).toBe(true);
    expect(batches()).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM observer_queue_members').get()).toEqual({n:2});
  });
  it('never applies observation-source filtering to summarize events', () => {
    add(83,{queueKind:'summary',payload:JSON.stringify({tool_name:'update_plan',tool_input:{items:[]},last_assistant_message:'Session findings',prompt_number:1})});
    expect(queue().prepareBatch()).toBe(true);
    expect(batches()).toHaveLength(1);
    expect(JSON.parse(batches()[0].body).messages[0].content).toContain('Session findings');
  });
  it('filters an SDK-owned durable plan before initializing a generator and keeps its source', () => {
    const id=add(91,{queueContext:undefined,payload:JSON.stringify({tool_name:'update_plan',tool_input:{items:[]},tool_response:'Plan shown'})});
    const sessions=new SessionManager(manager);
    const old=process.env.CLAUDE_MEM_LLM_QUEUE_URL;
    delete process.env.CLAUDE_MEM_LLM_QUEUE_URL;
    try {
      sessions.queueObservation(session,{recoveryTaskId:id,tool_name:'update_plan',tool_input:{items:[]},tool_response:'Plan shown'} as any);
      expect(tasks.get(id)?.state).toBe('skipped');
      expect(tasks.get(id)?.payload).toContain('Plan shown');
      expect(sessions.getMessageBuffer().getPendingCount(session)).toBe(0);
    } finally {if(old!==undefined) process.env.CLAUDE_MEM_LLM_QUEUE_URL=old;}
  });
  it('recovers a missing title from the emitted subtitle and keeps output/id positions explicit', async () => {
    const id=add(72);
    const worker=queue(async(_url:any,req:any)=>{
      const result=await response(req).json();
      result.job.response.content[0].text='<observation><type>discovery</type><facts><fact>No display label</fact></facts></observation>'+
        '<observation><type>discovery</type><subtitle>Cache collision confirmed</subtitle><facts><fact>Keys omit facts</fact></facts></observation>';
      return Response.json(result);
    });
    worker.prepareBatch();await worker.processBatch(batches()[0]);
    const outcome=JSON.parse(tasks.get(id)!.outcome!);
    expect(outcome.observationFiltering.sourceIndices).toEqual([1]);
    expect(outcome.observationFiltering.rejected).toEqual([{outputIndex:0,reason:'missing_title'}]);
    expect(outcome.insertedObservationIds).toHaveLength(1);
    const row=store.getObservationById(outcome.insertedObservationIds[0]);
    expect(row?.title).toBe('Cache collision confirmed');
    expect(JSON.parse(row!.facts)).toEqual(['Keys omit facts']);
  });
});
