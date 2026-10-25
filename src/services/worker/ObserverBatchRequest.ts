/** Pure production request builder shared by the queue and offline evaluation. */
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import type { ModeConfig } from '../domain/types.js';

export const OBSERVER_DEFAULT_PROFILE = {maxItems:20, maxBytes:64000, max_tokens:4096};
export function validateObserverProfile(config: {maxItems:number;maxBytes:number}): void {
  if (!Number.isSafeInteger(config.maxItems) || config.maxItems<1 || config.maxItems>20 ||
      !Number.isSafeInteger(config.maxBytes) || config.maxBytes<4096 || config.maxBytes>256000) {
    throw new Error('invalid_observer_batch_budget');
  }
}

export function boundedSummaryContext(prior: unknown[]): unknown[] {
  const bounded: unknown[] = [];
  for (const fact of prior.slice(0,20)) {
    if (Buffer.byteLength(JSON.stringify([...bounded,fact]))>12000) break;
    bounded.push(fact);
  }
  return bounded;
}

export function buildObserverBatch(candidates: any[], mode: ModeConfig,
    config: {maxItems:number;maxBytes:number}, prior: unknown[] = []):
    {selected:any[];body:any;overBudget:boolean;bytes:number} {
  validateObserverProfile(config);
  if (!candidates.length) throw new Error('empty_observer_candidates');
  const first=candidates[0], context=JSON.parse(first.context), firstInput=JSON.parse(first.payload);
  const system=buildInitPrompt(context.project,first.content_session_id,context.userPrompt || '',mode)+
    '\nThis request is an independent batch. Use only the supplied records. If none contains durable facts, output <skip_summary reason="no durable facts"/>.';
  const selected:any[]=[], prompts:string[]=[];
  const body:any={model:'claude_mem.observation',max_tokens:4096,system,messages:[{role:'user',content:''}]};
  for (const row of candidates) {
    if (row.session_db_id !== first.session_db_id) continue;
    if (row.context !== first.context || row.kind !== first.kind) break;
    if (selected.length >= (first.kind === 'summary' ? 1 : config.maxItems)) break;
    const input=JSON.parse(row.payload);
    if (input.prompt_number !== firstInput.prompt_number || input.agentId !== firstInput.agentId ||
        input.agentType !== firstInput.agentType) break;
    let prompt=first.kind === 'summary'
      ? buildSummaryPrompt({id:row.session_db_id,memory_session_id:null,project:context.project,
          user_prompt:context.userPrompt || '',last_assistant_message:input.last_assistant_message || ''},mode)
      : buildObservationPrompt({id:0,recoveryTaskId:row.id,tool_name:input.tool_name,
          tool_input:input.tool_input,tool_output:input.tool_response,
          created_at_epoch:row.enqueued_at_epoch,cwd:input.cwd},Number.POSITIVE_INFINITY);
    if (first.kind === 'summary') prompt+='\nPersisted observations (bounded most recent subset):\n'+JSON.stringify(boundedSummaryContext(prior));
    body.messages[0].content=[...prompts,prompt].join('\n\n');
    if (Buffer.byteLength(JSON.stringify(body))>config.maxBytes) {
      if (!selected.length) return {selected:[],body,overBudget:true,bytes:Buffer.byteLength(JSON.stringify(body))};
      break;
    }
    selected.push(row);prompts.push(prompt);
  }
  body.messages[0].content=prompts.join('\n\n');
  return {selected,body,overBudget:false,bytes:Buffer.byteLength(JSON.stringify(body))};
}
