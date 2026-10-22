import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayObserverQueue, MAX_HOLD_MS, MAX_REKEYS, MAX_SAME_KEY_RETRIES, PAUSE_PROBE_MS } from '../../src/services/worker/GatewayObserverQueue.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

/**
 * The gateway's disposition field drives the queue (fleet-ops
 * model-gateway-integration §7). A fake gateway answers; no model or network.
 */
describe('gateway observer queue follows the gateway disposition', () => {
  let db: Database, tasks: ObserverTaskStore, store: SessionStore, manager: any, config: any;
  let dir: string, session: number, now: number, calls: {path: string; key: string}[];
  let answer: (path: string, key: string, req: any) => Response;
  beforeEach(() => {
    dir=mkdtempSync(join(tmpdir(),'cm-queue-disposition-'));
    writeFileSync(join(dir,'token'),'test-caller-token',{mode:0o600});
    db=new Database(join(dir,'test.sqlite3'));
    store=new SessionStore(db);
    tasks=new ObserverTaskStore(db);
    session=store.createSDKSession('source-session','project','user request');
    manager={getConnection:()=>db,getSessionStore:()=>store,getObserverTaskStore:()=>tasks,getCloudSync:()=>null};
    config={url:'http://127.0.0.1:39000',tokenFile:join(dir,'token'),maxItems:1,maxBytes:64000,submitsPerMinute:60};
    ModeManager.getInstance().loadMode('code');
    now=1_800_000_000_000; calls=[];
    answer=(_path,key)=>job(key,'queued');
  });
  afterEach(() => {db.close();rmSync(dir,{recursive:true,force:true});});

  let n=0;
  function add() {
    n++;
    return tasks.create({sessionDbId:session,contentSessionId:'source-session',sourceId:'tool-'+n,
      payload:JSON.stringify({tool_name:'Read',tool_input:'{"file_path":"/source.ts"}',tool_response:'fact '+n,prompt_number:1}),
      enqueuedAtEpoch:1700000000000+n,queueContext:{project:'project',userPrompt:'request'}});
  }
  function job(key: string, state: string, extra: any={}) {
    return Response.json({version:1,job:{request_key:key,business_key:'claude_mem.observation',state,...extra}});
  }
  function succeeded(key: string) {
    return job(key,'succeeded',{response:{model:'m',stop_reason:'end_turn',
      content:[{type:'text',text:'<skip_summary reason="no durable facts"/>'}],usage:{input_tokens:1,output_tokens:1}}});
  }
  const batches = (): any[] => db.prepare('SELECT * FROM observer_queue_batches ORDER BY created_at,attempt,id').all() as any[];
  const batch = (id: string): any => db.prepare('SELECT * FROM observer_queue_batches WHERE id=?').get(id);
  function queue() {
    return new GatewayObserverQueue(manager,config,(async (url: any, req: any) => {
      const path=new URL(url).pathname, key=req.headers['Idempotency-Key'] || JSON.parse(req.body).idempotency_key;
      calls.push({path,key});
      return answer(path,key,JSON.parse(req.body));
    }) as any,()=>now);
  }
  const status = () => (new SessionManager(manager).getDurableQueueStatus() as any);
  const withQueueEnv = <T>(fn: () => T): T => {
    const prior=process.env.CLAUDE_MEM_LLM_QUEUE_URL;
    process.env.CLAUDE_MEM_LLM_QUEUE_URL='http://127.0.0.1:39000';
    try { return fn(); } finally { if (prior===undefined) delete process.env.CLAUDE_MEM_LLM_QUEUE_URL; else process.env.CLAUDE_MEM_LLM_QUEUE_URL=prior; }
  };

  it('paused: records the batch as paused, stops batching and submitting, probes on the long interval', async () => {
    const first=add(); add();
    const paused={code:'business_route_disabled',message:'业务路由已暂停',disposition:'paused'};
    answer=(_path,key)=>job(key,'queued',{error:paused});
    const worker=queue();
    await worker.cycle();
    // Only the first submit went out: the refusal stopped the second one.
    expect(calls.map(c=>c.path)).toEqual(['/v1/queue/submit']);
    const probeId=calls[0].key;
    expect(batch(probeId)).toMatchObject({state:'paused'});
    expect(tasks.get(first)?.state).toBe('running');
    expect(withQueueEnv(status).gateway).toMatchObject({state:'paused',source:'model_gateway',reason:'business_route_disabled',probe_batch:probeId});

    // Work keeps arriving; nothing is batched or sent while the route is paused.
    add(); add();
    const before=batches().length;
    for (let i=0;i<10;i++) { now+=20_000; await worker.cycle(); }
    expect(calls).toHaveLength(1);
    expect(batches().length).toBe(before);

    // After the interval: exactly one probe, for the same key, and still paused.
    now+=PAUSE_PROBE_MS;
    await worker.cycle();
    expect(calls.slice(1)).toEqual([{path:'/v1/queue/status',key:probeId}]);
    expect(worker.hold()?.kind).toBe('paused');

    // The route is back: the probe reopens it and work resumes under the same keys.
    now+=PAUSE_PROBE_MS;
    answer=(_path,key)=>job(key,'running');
    await worker.cycle();
    expect(worker.hold()).toBeNull();
    expect(calls[2]).toEqual({path:'/v1/queue/status',key:probeId});
    expect(calls.slice(3).some(c=>c.path==='/v1/queue/submit')).toBe(true);
    expect(withQueueEnv(status).gateway).toEqual({state:'open'});
    // A pause is never a failure or a reconciliation.
    expect(db.prepare("SELECT count(*) AS n FROM observer_tasks WHERE state IN ('failed','reconciliation')").get()).toEqual({n:0});
  });

  it('keeps a pause across a worker restart', async () => {
    add();
    answer=(_path,key)=>job(key,'queued',{error:{code:'provider_circuit_open',disposition:'paused'}});
    await queue().cycle();
    add();
    now+=60_000;
    await queue().cycle();
    expect(calls).toHaveLength(1);
  });

  it('retry with same_key: waits retry_after_seconds and keeps the original key', async () => {
    add(); add();
    const deferred={code:'cost_limit_exceeded',message:'每分钟请求数已达上限',disposition:'retry',same_key:true,retry_after_seconds:20};
    answer=(_path,key)=>job(key,'queued',{error:deferred});
    const worker=queue();
    await worker.cycle();
    expect(calls).toHaveLength(1);
    const key=calls[0].key;
    expect(withQueueEnv(status).gateway).toMatchObject({state:'retry_backoff',reason:'cost_limit_exceeded'});
    now+=19_000;
    await worker.cycle();
    expect(calls).toHaveLength(1);
    now+=2_000;
    answer=(_path,k)=>job(k,'running');
    await worker.cycle();
    expect(calls[1]).toEqual({path:'/v1/queue/status',key});
    // No resubmission of that batch under another key.
    expect(batches().filter(b=>b.attempt>0)).toHaveLength(0);
    expect(worker.hold()).toBeNull();
  });

  it('retry without retry_after_seconds backs off on a bounded, growing interval', async () => {
    add();
    answer=(_path,key)=>job(key,'queued',{error:{code:'cost_limit_exceeded',disposition:'retry',same_key:true}});
    const worker=queue();
    await worker.cycle();
    const first=worker.hold()!;
    expect(first.until-now).toBe(15_000);
    now=first.until;
    await worker.cycle();
    expect(worker.hold()!.until-now).toBe(30_000);
    expect(worker.hold()!.since).toBe(first.since);
  });

  it('retry with same_key=false on a terminal job: same request under a new key, bounded', async () => {
    const id=add();
    answer=(path,key)=>path==='/v1/queue/submit' ? job(key,'queued')
      : job(key,'failed',{error:{code:'provider_rate_limited',disposition:'retry',same_key:false}});
    const worker=queue();
    await worker.cycle();          // submit
    await worker.cycle();          // status → failed, retry with a new key
    const [old, fresh]=batches();
    expect(old.state).toBe('superseded');
    expect(JSON.parse(old.receipt).state).toBe('failed');
    expect(fresh).toMatchObject({state:'pending',attempt:1,body:old.body});
    expect(fresh.id).not.toBe(old.id);
    expect(db.prepare('SELECT batch_id FROM observer_queue_members WHERE task_id=?').get(id)).toEqual({batch_id:fresh.id});
    expect(tasks.get(id)?.state).toBe('running');
    // After the backoff the new key goes out; the old key gets its receipt.
    now=worker.hold()!.until;
    answer=(path,key,req)=>path==='/v1/queue/ack'
      ? job(key,'failed',{business_receipt:req.receipt}) : job(key,'queued');
    await worker.cycle();
    expect(calls.filter(c=>c.path==='/v1/queue/submit').map(c=>c.key)).toEqual([old.id,fresh.id]);
    expect(batch(old.id).acknowledged).toBe(1);

    // Bounded: once the new keys are spent the batch ends as failed, never reconciliation.
    answer=(path,key)=>path==='/v1/queue/ack' ? job(key,'failed',{business_receipt:{state:'failed',reference:'sqlite:observer_queue_batches:'+key}})
      : job(key,'failed',{error:{code:'provider_rate_limited',disposition:'retry',same_key:false}});
    for (let i=0;i<20 && tasks.get(id)?.state==='running';i++) { now+=MAX_HOLD_MS; await worker.cycle(); }
    expect(tasks.get(id)?.state).toBe('failed');
    expect(Math.max(...batches().map(b=>b.attempt))).toBe(MAX_REKEYS);
  });

  it('failed: marks the batch failed, no retry and no reconciliation', async () => {
    const id=add();
    answer=(_path,key)=>job(key,'failed',{error:{code:'cost_limit_exceeded',message:'单次请求成本超过上限',disposition:'failed'}});
    const worker=queue();
    await worker.cycle();
    expect(tasks.get(id)?.state).toBe('failed');
    expect(batches()).toHaveLength(1);
    expect(JSON.parse(batches()[0].receipt).state).toBe('failed');
    expect(worker.hold()).toBeNull();
  });

  it('the same code takes opposite paths by disposition', async () => {
    const failedTask=add(), retryTask=add();
    answer=(_path,key)=>job(key,'queued');
    const worker=queue();
    await worker.cycle();
    const failedKey=(db.prepare('SELECT batch_id FROM observer_queue_members WHERE task_id=?').get(failedTask) as any).batch_id;
    answer=(path,key)=>path==='/v1/queue/submit' ? job(key,'queued') : path==='/v1/queue/ack'
      ? job(key,'failed',{business_receipt:{state:'failed',reference:'sqlite:observer_queue_batches:'+key}})
      : job(key,'failed',{error:{code:'cost_limit_exceeded',
        ...(key===failedKey ? {disposition:'failed'} : {disposition:'retry',same_key:false})}});
    // Whichever is read first: a retry holds the route, the probe reopens it.
    for (let i=0;i<3;i++) { await worker.cycle(); now=worker.hold()?.until ?? now; }
    expect(tasks.get(failedTask)?.state).toBe('failed');
    expect(tasks.get(retryTask)?.state).toBe('running');
    expect(batches().filter(b=>b.attempt===1)).toHaveLength(1);
  });

  it('reconciliation: only this writes reconciliation, and it is re-read, never re-sent', async () => {
    const id=add();
    answer=(_path,key)=>job(key,'reconciliation',{error:{code:'provider_timeout',disposition:'reconciliation'}});
    const worker=queue();
    await worker.cycle();
    expect(tasks.get(id)?.state).toBe('reconciliation');
    expect(batches()[0].receipt).toBeNull();
    await worker.cycle();
    expect(calls).toHaveLength(1);
    now+=60_000;
    await worker.cycle();
    expect(calls.map(c=>c.path)).toEqual(['/v1/queue/submit','/v1/queue/status']);
  });

  it('a failed job without a disposition is treated as reconciliation', async () => {
    const id=add();
    answer=(_path,key)=>job(key,'failed',{error:{code:'internal_error'}});
    await queue().cycle();
    expect(tasks.get(id)?.state).toBe('reconciliation');
    expect(batches()[0].receipt).toBeNull();
  });

  it('a queue call refused with retry keeps the batch and its key, then backs off', async () => {
    add(); add();
    answer=(_path,_key)=>Response.json({error:{code:'gateway_busy',disposition:'retry',same_key:true,retry_after_seconds:30}},{status:503});
    const worker=queue();
    await worker.cycle();
    expect(calls).toHaveLength(1);
    expect(batch(calls[0].key).state).toBe('pending');
    expect(worker.hold()).toMatchObject({kind:'retry',code:'gateway_busy',until:now+30_000});
    now+=30_000;
    answer=(_path,key)=>job(key,'queued');
    await worker.cycle();
    expect(calls[1]).toEqual({path:'/v1/queue/submit',key:calls[0].key});
  });

  it('a terminal failed job that says paused is held as a pause under its original key (§6.3②)', async () => {
    const id=add();
    answer=(path,key)=>path==='/v1/queue/submit' ? job(key,'queued')
      : job(key,'failed',{error:{code:'business_route_disabled',disposition:'paused'}});
    const worker=queue();
    await worker.cycle();          // submit
    await worker.cycle();          // status → failed + paused
    const key=calls[0].key;
    for (let i=0;i<10;i++) { now+=PAUSE_PROBE_MS; await worker.cycle(); }
    // Never a new key, never a failure, never a receipt: one status probe per interval.
    expect(batches()).toHaveLength(1);
    expect(batch(key)).toMatchObject({state:'paused',receipt:null});
    expect(tasks.get(id)?.state).toBe('running');
    expect(worker.hold()?.kind).toBe('paused');
    expect(calls.slice(1).every(c=>c.path==='/v1/queue/status' && c.key===key)).toBe(true);
    expect(calls).toHaveLength(12);
  });

  it('a submit refused with retry and same_key=true is retried under the same key a bounded number of times (§7.2)', async () => {
    const id=add();
    answer=()=>Response.json({error:{code:'cost_limit_exceeded',disposition:'retry',same_key:true,retry_after_seconds:30}},{status:429});
    const worker=queue();
    for (let i=0;i<30;i++) { await worker.cycle(); now+=MAX_HOLD_MS; }
    const submits=calls.filter(c=>c.path==='/v1/queue/submit');
    expect(submits).toHaveLength(1+MAX_SAME_KEY_RETRIES);
    expect(new Set(submits.map(c=>c.key)).size).toBe(1);
    // Ends as a temporary failure: no job exists, so no receipt; never reconciliation.
    expect(batches()).toHaveLength(1);
    expect(batches()[0]).toMatchObject({state:'failed',receipt:null});
    expect(tasks.get(id)).toMatchObject({state:'failed',outcome:'gateway_retry_exhausted'});
    expect(worker.hold()).toBeNull();
  });

  it('a submit refused with retry and same_key=false stops once the new keys are spent (§7.2)', async () => {
    const id=add();
    answer=()=>Response.json({error:{code:'http_start_admission_rejected',disposition:'retry',same_key:false}},{status:503});
    const worker=queue();
    for (let i=0;i<30;i++) { await worker.cycle(); now+=MAX_HOLD_MS; }
    const submits=calls.filter(c=>c.path==='/v1/queue/submit');
    // The original key and MAX_REKEYS new ones, each sent once, never back to an old key.
    expect(submits).toHaveLength(1+MAX_REKEYS);
    expect(new Set(submits.map(c=>c.key)).size).toBe(1+MAX_REKEYS);
    expect(tasks.get(id)).toMatchObject({state:'failed',outcome:'gateway_retry_exhausted'});
    expect(batches().every(b=>b.receipt===null)).toBe(true);
    expect(batches().filter(b=>b.state==='failed')).toHaveLength(1);
  });

  it('a queue call refused as paused stops the route', async () => {
    add(); add();
    answer=()=>Response.json({error:{code:'business_route_disabled',disposition:'paused'}},{status:503});
    const worker=queue();
    await worker.cycle();
    expect(calls).toHaveLength(1);
    expect(worker.hold()).toMatchObject({kind:'paused',until:now+PAUSE_PROBE_MS});
  });

  it('a probe with no answer from the gateway keeps the route held', async () => {
    add();
    answer=(_path,key)=>job(key,'queued',{error:{code:'business_route_disabled',disposition:'paused'}});
    const worker=queue();
    await worker.cycle();
    now+=PAUSE_PROBE_MS;
    answer=()=>{ throw new Error('relay unreachable'); };
    await worker.cycle();
    expect(worker.hold()).toMatchObject({kind:'paused',until:now+PAUSE_PROBE_MS});
  });

  it('throttles submits to the route per-minute limit', async () => {
    config.submitsPerMinute=2;
    for (let i=0;i<5;i++) add();
    const worker=queue();
    while (worker.prepareBatch()) {}
    await worker.cycle();
    expect(calls.filter(c=>c.path==='/v1/queue/submit')).toHaveLength(2);
    now+=30_000;
    await worker.cycle();
    expect(calls.filter(c=>c.path==='/v1/queue/submit')).toHaveLength(2);
    now+=31_000;
    await worker.cycle();
    expect(calls.filter(c=>c.path==='/v1/queue/submit')).toHaveLength(4);
  });

  it('a succeeded probe reopens the route', async () => {
    add();
    answer=(_path,key)=>job(key,'queued',{error:{code:'cost_limit_exceeded',disposition:'retry',same_key:true}});
    const worker=queue();
    await worker.cycle();
    now=worker.hold()!.until;
    answer=(path,key)=>path==='/v1/queue/ack' ? job(key,'succeeded',{business_receipt:{state:'completed',reference:'sqlite:observer_queue_batches:'+key}}) : succeeded(key);
    await worker.cycle();
    expect(worker.hold()).toBeNull();
  });
});
