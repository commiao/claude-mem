import {describe,it,expect} from 'bun:test';
import {buildObserverBatch,boundedSummaryContext} from '../../src/services/worker/ObserverBatchRequest.js';
import {ModeManager} from '../../src/services/domain/ModeManager.js';
import {buildInitPrompt,buildObservationPrompt} from '../../src/sdk/prompts.js';

const mode=ModeManager.getInstance().loadMode('code');
const context=JSON.stringify({project:'synthetic',userPrompt:'fix session ownership'});
function row(i:number,patch:any={}) {return {id:'t'+i,session_db_id:1,content_session_id:'session-A',context,kind:'observation',
  payload:JSON.stringify({tool_name:'Edit',tool_input:{file_path:'路径.ts'},tool_response:'12 tests passed',prompt_number:1}),
  enqueued_at_epoch:1000+i,...patch};}

describe('shared production request builder',()=>{
  it('retains exact production prompt and JS byte accounting',()=>{
    const source=row(1),input=JSON.parse(source.payload);
    const body={model:'claude_mem.observation',max_tokens:4096,
      system:buildInitPrompt('synthetic','session-A','fix session ownership',mode)+
        '\nThis request is an independent batch. Use only the supplied records. If none contains durable facts, output <skip_summary reason="no durable facts"/>.',
      messages:[{role:'user',content:buildObservationPrompt({id:0,recoveryTaskId:source.id,tool_name:input.tool_name,
        tool_input:input.tool_input,tool_output:input.tool_response,created_at_epoch:source.enqueued_at_epoch,cwd:input.cwd},Infinity)}]};
    const result=buildObserverBatch([source],mode,{maxItems:20,maxBytes:64000});
    expect(result.body).toEqual(body);
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(result.bytes).toBeGreaterThan(JSON.stringify(body).length);
  });
  it('never crosses context, prompt number or agent boundary',()=>{
    for (const next of [row(2,{context:JSON.stringify({project:'other'})}),
      row(2,{payload:JSON.stringify({prompt_number:2})}),row(2,{payload:JSON.stringify({prompt_number:1,agentId:'other'})})]) {
      expect(buildObserverBatch([row(1),next],mode,{maxItems:20,maxBytes:64000}).selected.map(r=>r.id)).toEqual(['t1']);
    }
  });
  it('caps records and rejects oversized inputs before calls',()=>{
    expect(buildObserverBatch([row(1),row(2)],mode,{maxItems:1,maxBytes:64000}).selected.length).toBe(1);
    const huge=row(1,{payload:JSON.stringify({tool_name:'Edit',tool_input:{content:'x'.repeat(90000)}})});
    expect(buildObserverBatch([huge],mode,{maxItems:20,maxBytes:64000}).overBudget).toBe(true);
    expect(()=>buildObserverBatch([row(1)],mode,{maxItems:21,maxBytes:64000})).toThrow();
  });
  it('bounds summary context to twenty and twelve thousand bytes',()=>{
    expect(boundedSummaryContext(Array.from({length:30},(_,i)=>({title:'fact'+i}))).length).toBe(20);
    const bounded=boundedSummaryContext([{title:'a'.repeat(8000)},{title:'b'.repeat(8000)}]);
    expect(bounded.length).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(12000);
  });
});
