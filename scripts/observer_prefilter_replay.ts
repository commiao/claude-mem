/** Replay only queue preparation against frozen sources. No HTTP or model execution. */
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const [evidence,out]=process.argv.slice(2);
if (!evidence||!out) throw new Error('usage: observer_prefilter_replay.ts EVIDENCE OUT');
process.env.CLAUDE_MEM_DATA_DIR=mkdtempSync(join(tmpdir(),'memcheck-prefilter-'));
process.env.CLAUDE_MEM_LOG_LEVEL='ERROR';
const {SessionStore}=await import('../src/services/sqlite/SessionStore.js');
const {ObserverTaskStore}=await import('../src/services/worker/ObserverTaskStore.js');
const {GatewayObserverQueue}=await import('../src/services/worker/GatewayObserverQueue.js');
const {ModeManager}=await import('../src/services/domain/ModeManager.js');
ModeManager.getInstance().loadMode('code');
const cases=JSON.parse(readFileSync(join(evidence,'cases.json'),'utf8'));
const replies=JSON.parse(readFileSync(join(evidence,'historical-results.json'),'utf8'));
const labels=new Map(JSON.parse(readFileSync(join(evidence,'review-annotations-v2.json'),'utf8')).cases.map((c:any)=>[c.case_id,c.input_value]));
const rows=[];let networkCalls=0;
for (const c of cases) {
  const store=new SessionStore(':memory:');
  try {
    const db=store.db,tasks=new ObserverTaskStore(db);
    const sid=store.createSDKSession(c.id,c.project,c.user_prompt||'');
    const ids=c.records.map((r:any,i:number)=>tasks.create({sessionDbId:sid,contentSessionId:c.id,sourceId:c.id+':'+i,
      payload:JSON.stringify({...r,prompt_number:1}),enqueuedAtEpoch:r.enqueued_at_epoch,
      queueContext:{project:c.project,userPrompt:c.user_prompt||''}}));
    const manager={getConnection:()=>db,getSessionStore:()=>store,getObserverTaskStore:()=>tasks};
    const worker=new GatewayObserverQueue(manager as any,{url:'http://127.0.0.1:1',tokenFile:'/no-token',maxItems:20,maxBytes:64000},
      (()=>{networkCalls++;throw new Error('offline_network_forbidden');}) as typeof fetch);
    while(worker.prepareBatch()) {}
    const batchCount=(db.prepare('SELECT count(*) AS n FROM observer_queue_batches').get() as any).n;
    const taskRows=ids.map((id:string)=>tasks.get(id)!);
    const skipped=taskRows.every((t:any)=>t.state==='skipped');
    const intact=taskRows.every((t:any,i:number)=>t.payload===JSON.stringify({...c.records[i],prompt_number:1}));
    if (!intact || (!skipped&&batchCount!==1)) throw new Error('source_grouping_or_integrity_changed');
    rows.push({id:c.id,input_value:labels.get(c.id),source_tasks:ids.length,skipped,batchCount,
      reason:skipped?JSON.parse(taskRows[0].outcome!).reason:null,source_retained:intact,
      historical_usage:replies[c.id].usage});
  } finally {store.close();}
}
const omitted=rows.filter(r=>r.skipped);
const usage=(selected:any[])=>Object.fromEntries(['input_tokens','output_tokens','cache_read_input_tokens'].map(k=>[k,selected.reduce((n,r)=>n+(r.historical_usage?.[k]??0),0)]));
const result={method:'real candidate GatewayObserverQueue.prepareBatch + disposable SQLite; no submissions',
  cases:rows.length,source_tasks:rows.reduce((n,r)=>n+r.source_tasks,0),would_skip_batches:omitted.length,
  remaining_batches:rows.reduce((n,r)=>n+r.batchCount,0),valuable_source_batches_skipped:omitted.filter(r=>r.input_value==='valuable').length,
  all_raw_sources_retained:rows.every(r=>r.source_retained),new_model_calls:0,network_calls:networkCalls,
  historical_total_usage_fields:usage(rows),historical_avoidable_usage_fields:usage(omitted),
  money_savings_measured:false,production_changed:false,rows};
writeFileSync(out,JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,rows:undefined}));
