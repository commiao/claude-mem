/** Replay frozen replies through the real parser, gate and SQLite store. No model or live DB. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [evidenceArg, baselineArg, candidateArg, outArg] = process.argv.slice(2);
if (!evidenceArg || !baselineArg || !candidateArg || !outArg) {
  throw new Error('usage: observer_persistence_replay.ts EVIDENCE BASELINE_SOURCE CANDIDATE_SOURCE NEW_OUT');
}
const evidence=resolve(evidenceArg), baseline=resolve(baselineArg), candidate=resolve(candidateArg), out=resolve(outArg);
// Never open, copy or mutate the real database, including through DATA_DIR.
if (existsSync(out)) throw new Error('output_directory_must_be_new');
mkdirSync(out,{recursive:true,mode:0o700});
process.env.CLAUDE_MEM_DATA_DIR=mkdtempSync(join(tmpdir(),'memcheck-offline-'));
process.env.CLAUDE_MEM_LOG_LEVEL='ERROR';
process.env.CLAUDE_MEM_DEDUP_ENABLED='false';
// Any accidental network access in a future imported dependency fails closed.
globalThis.fetch=(() => { throw new Error('offline_replay_network_forbidden'); }) as typeof fetch;
const names=['cases.json','historical-results.json','db-snapshot-evidence.json'];
const hashes=Object.fromEntries(names.map(name=>[name,createHash('sha256').update(readFileSync(join(evidence,name))).digest('hex')]));
const cases=JSON.parse(readFileSync(join(evidence,'cases.json'),'utf8'));
const replies=JSON.parse(readFileSync(join(evidence,'historical-results.json'),'utf8'));
if (!Array.isArray(cases) || !cases.length) throw new Error('nonempty_frozen_cases_required');

async function replay(root: string, name: string) {
  process.env.CLAUDE_MEM_MODES_DIR=join(root,'plugin/modes');
  const load=async (path:string)=>import(pathToFileURL(join(root,path)).href);
  const {ModeManager}=await load('src/services/domain/ModeManager.ts');
  ModeManager.getInstance().loadMode('code');
  const {parseAgentXml}=await load('src/sdk/parser.ts');
  const normal=await load('src/services/worker/agents/ObservationNormalization.ts');
  const {SessionStore}=await load('src/services/sqlite/SessionStore.ts');
  const gate=existsSync(join(root,'src/services/worker/agents/ObservationQualityGate.ts'))
    ? (await load('src/services/worker/agents/ObservationQualityGate.ts')).gateObservationPersistence : null;
  const store=new SessionStore(join(out,name+'.sqlite3'));
  const rows:any[]=[];
  try {
    for (const c of [...cases].reverse()) {
      if (c.kind!=='observation' || typeof replies[c.id]?.text!=='string') throw new Error('frozen_observation_reply_required');
      const parsed=parseAgentXml(replies[c.id].text);
      if (!parsed.valid) throw new Error('historical_parse_failed:'+c.id);
      const sources=c.records.map((r:any)=>({...r,type:'observation'}));
      const files=normal.extractObservationFileEvidence(sources);
      const all=normal.sanitizeObservationFiles(parsed.observations,files);
      const prepared=gate ? gate(all,sources) : {
        observations:all.filter((o:any)=>typeof o.title==='string'&&o.title.trim()),
        sourceIndices:all.map((_:any,i:number)=>i).filter((i:number)=>typeof all[i].title==='string'&&all[i].title.trim()),
        rejected:all.flatMap((o:any,i:number)=>typeof o.title==='string'&&o.title.trim()?[]:[{outputIndex:i,reason:'missing_title'}]),
      };
      const contentId=c.records[0]?.content_session_id ?? c.id;
      const sid=store.createSDKSession(contentId,c.project,c.user_prompt||'');
      const memoryId='offline-'+contentId;
      store.updateMemorySessionId(sid,memoryId);
      const result=store.storeObservations(memoryId,c.project,prepared.observations,null,
        c.records[0]?.prompt_number??1,0,c.records[0]?.enqueued_at_epoch,'historical-replay-no-generation');
      const inserted=new Set(result.insertedObservationIds);
      const outputs=all.map((observation:any,outputIndex:number)=>{
        const position=prepared.sourceIndices.indexOf(outputIndex);
        const id=position<0?undefined:result.observationIds[position];
        const persistedIds=id!==undefined&&inserted.has(id)?[id]:[];
        const readback=id===undefined?null:store.getObservationById(id);
        if (id!==undefined && (!readback || readback.title!==observation.title ||
            JSON.stringify(JSON.parse(readback.facts))!==JSON.stringify(observation.facts))) {
          throw new Error('sqlite_readback_mismatch:'+c.id+':'+outputIndex);
        }
        return {outputIndex,observation,persistedIds,storedId:id??null,
          rejection:prepared.rejected.find((r:any)=>r.outputIndex===outputIndex)?.reason??null};
      });
      rows.push({caseId:c.id,sourceTasks:c.records.length,action:all.length?'generated':parsed.summary?.skipped?'skip':'empty',
        sourceIndices:prepared.sourceIndices,rejected:prepared.rejected,outputs,result});
    }
    return {name,source:root,initial_state:'empty isolated SQLite; optional cross-session title merge disabled',
      readback_verified:true,rows,uniqueNewObservations:rows.reduce((n,r)=>n+r.result.insertedObservationIds.length,0),
      batchesWithInsertions:rows.filter(r=>r.result.insertedObservationIds.length).length};
  } finally { store.close(); }
}
const before=await replay(baseline,'baseline'), after=await replay(candidate,'candidate');
// Copying a display title must not rewrite the original technical content.
for (const row of before.rows) {
  const other=after.rows.find(r=>r.caseId===row.caseId);
  if (!other || row.outputs.length!==other.outputs.length) throw new Error('output_identity_changed');
  row.outputs.forEach((o:any,i:number)=>{
    const {title:oldTitle,...oldBody}=o.observation;
    const {title:newTitle,...newBody}=other.outputs[i].observation;
    if (JSON.stringify(oldBody)!==JSON.stringify(newBody) || (oldTitle && oldTitle!==newTitle)) {
      throw new Error('accepted_body_changed:'+row.caseId+':'+i);
    }
  });
}
const result={method:'fixed historical reply replay through production parser/gate/SessionStore with actual temporary SQLite readback',
  new_model_calls:0,production_database_access:false,sourceHashes:hashes,before,after,
  body_preservation_verified:true,production_allowed:false};
writeFileSync(join(out,'replay.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({cases:cases.length,new_model_calls:0,before:before.uniqueNewObservations,after:after.uniqueNewObservations,
  readback_verified:true,body_preservation_verified:true,report:join(out,'replay.json')}));
