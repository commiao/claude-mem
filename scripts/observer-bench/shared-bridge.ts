/** Standalone business bridge: environment is set before importing production modules. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const [action,dataDir,modeDir]=process.argv.slice(2);
  if (!['build','parse'].includes(action)||!dataDir||!modeDir) throw new Error('invalid_bridge_arguments');
  process.env.CLAUDE_MEM_DATA_DIR=resolve(dataDir);
  process.env.CLAUDE_MEM_MODES_DIR=resolve(modeDir);
  const {ModeManager}=await import('../../src/services/domain/ModeManager.js');
  const mode=ModeManager.getInstance().loadMode('code');
  const value=JSON.parse(readFileSync(0,'utf8'));
  if (action==='build') {
    const {buildObserverBatch,OBSERVER_DEFAULT_PROFILE}=await import('../../src/services/worker/ObserverBatchRequest.js');
    const profile={...OBSERVER_DEFAULT_PROFILE,...value.profile};
    const output:any[]=[];
    for (const c of value.cases) {
      if (c.request) {
        const bytes=Buffer.byteLength(JSON.stringify(c.request));
        if (bytes>profile.maxBytes) throw new Error('batch_input_over_budget:'+c.id);
        if (c.request.max_tokens!==4096||c.request.model!=='claude_mem.observation') throw new Error('captured_profile_mismatch');
        output.push({id:c.id+'.p1',case_id:c.id,body:c.request,bytes,records:c.records||[],profile,
          equivalence:'captured request; source grouping not independently verified'});
        continue;
      }
      const context=JSON.stringify({project:c.project||'offline-eval',userPrompt:c.user_prompt||'',...(c.context||{})});
      const records=c.kind==='summary' ? [{last_assistant_message:c.last_assistant_message||''}] : c.records;
      const candidates=records.map((r:any,i:number)=>({id:r.task_id||c.id+':'+i,session_db_id:r.session_db_id||c.session_db_id||1,
        content_session_id:r.content_session_id||c.content_session_id||c.id,context:r.context?JSON.stringify(r.context):context,
        kind:c.kind,payload:JSON.stringify({prompt_number:c.prompt_number??1,agentId:c.agent_id,agentType:c.agent_type,
          ...r,tool_response:r.tool_response??r.tool_output}),enqueued_at_epoch:r.enqueued_at_epoch??Date.parse(r.occurred_at||'2026-01-01T00:00:00Z')}));
      let pending=[...candidates],part=0;
      while (pending.length) {
        const batch=buildObserverBatch(pending,mode,profile,c.persisted_observations||[]);
        if (batch.overBudget) throw new Error('batch_input_over_budget:'+c.id);
        if (!batch.selected.length) throw new Error('empty_batch:'+c.id);
        const ids=new Set(batch.selected.map((r:any)=>r.id));
        output.push({id:c.id+'.p'+(++part),case_id:c.id,body:batch.body,bytes:batch.bytes,
          records:batch.selected.map((r:any)=>JSON.parse(r.payload)),profile,
          equivalence:'shared production request builder; effective deployed config not attested'});
        pending=pending.filter((r:any)=>!ids.has(r.id));
      }
    }
    console.log(JSON.stringify(output));
  } else {
    const {parseAgentXml}=await import('../../src/sdk/parser.js');
    const {extractObservationFileEvidence,sanitizeObservationFiles,normalizeSummaryForStorage,attachObservationFilesToSummary}=
      await import('../../src/services/worker/agents/ObservationNormalization.js');
    const parsed=parseAgentXml(value.text);
    if (!parsed.valid) {console.log(JSON.stringify({valid:false,parser_valid:false,value:null}));return;}
    const evidence=extractObservationFileEvidence(value.records.map((r:any)=>({...r,type:value.kind==='summary'?'summarize':'observation'})));
    const observations=sanitizeObservationFiles(parsed.observations,evidence);
    const summary=attachObservationFilesToSummary(normalizeSummaryForStorage(parsed.summary),[
      {files_read:evidence.files_read,files_modified:evidence.files_modified},...observations]);
    const valid=value.kind==='summary' ? observations.length===0 : !summary;
    console.log(JSON.stringify({valid,parser_valid:true,value:{observations,summary,skipped:!!parsed.summary?.skipped},
      persistence:'pure normalization only; no DB access'}));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
