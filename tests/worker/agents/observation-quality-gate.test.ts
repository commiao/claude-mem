import { describe, it, expect } from 'bun:test';
import { nonDurableSourceReason, gateObservationPersistence } from '../../../src/services/worker/agents/ObservationQualityGate.js';
import { parseAgentXml } from '../../../src/sdk/parser.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const observation = { type:'discovery', title:'Plan cache fix verified', subtitle:null,
  facts:['Cache no longer loses requests'], narrative:null, concepts:[], files_read:[], files_modified:[] };
const shell = (command: string, stdout='file.ts\n', extra={}) => ({type:'observation',tool_name:'Bash',
  tool_input:JSON.stringify({command}),tool_response:JSON.stringify({stdout,stderr:'',...extra})});
const plan = {type:'observation',tool_name:'mcp__ccd_turn__update_plan',tool_input:{items:[{content:'Fix cache',status:'pending'}]}};

describe('source-grounded observation persistence gate', () => {
  it('rejects plan bookkeeping with a reason and never uses the observation title as a classifier', () => {
    expect(gateObservationPersistence([observation],[plan]).rejected)
      .toEqual([{outputIndex:0,reason:'plan_bookkeeping_only'}]);
    expect(gateObservationPersistence([observation],[shell('cat cache.ts')]).observations).toEqual([observation]);
  });
  it('rejects only complete file inventories, including harmless formatting pipelines', () => {
    for (const command of ['ls src | head -30', 'find . -type f | sort | uniq -c',
      "cd /repo && ls | head -30; find . -type f | sed 's/[0-9]/N/g' | sort | uniq -c",
      'wc -l src/a.ts && ls tests | grep cache']) {
      expect(nonDurableSourceReason(shell(command))).toBe('file_inventory_only');
    }
  });
  it('keeps live code, errors, writes, substitutions, executable find/sed and mixed commands', () => {
    for (const command of ['ls; cat src/cache.ts', 'ls | python -c "print(1)"', 'find . -exec cat {} \\;',
      'find . -delete', 'ls > output', 'ls $(run_test)', 'ls `run_test`',
      "find . | sed '1r source.ts'", 'git diff --stat', 'ls && bun test',
      'ls; head source.ts', 'ls | sort source.ts', 'ls | grep bug source.ts',
      'ls; grep bug source.ts', 'head source.ts; ls', 'ls --help']) {
      expect(nonDurableSourceReason(shell(command))).toBeNull();
    }
    expect(nonDurableSourceReason(shell('ls', '', {stderr:'permission denied'}))).toBeNull();
    expect(nonDurableSourceReason(shell('ls', '', {exit_code:1}))).toBeNull();
    expect(nonDurableSourceReason(shell('ls', '', {interrupted:true}))).toBeNull();
  });
  it('recognizes archived episode dumps from provenance, not a numeric local memory ID', () => {
    const archive = shell("body=item['episode_body']\nprint(body)",
      'ok\n\n######## old-run obs 999999\n[FEATURE] Original title\nOld source facts.');
    expect(gateObservationPersistence([observation],[archive]).rejected[0].reason).toBe('retrieved_memory_only');
    // Analysing historical data is itself eligible evidence; no raw-dump header.
    expect(nonDurableSourceReason(shell("body=item['episode_body']; analyze(body)",
      'New analysis: replay confirmed a cache collision.'))).toBeNull();
    expect(nonDurableSourceReason(shell('cat live-code.ts',
      '######## example obs 999999\n[FEATURE] A literal example'))).toBeNull();
    expect(nonDurableSourceReason({...archive,tool_input:{command:"body=item['episode_body']\nprint(body)\nprint('New diagnosis: cache was corrupted')"}})).toBeNull();
    expect(gateObservationPersistence([observation],[archive,shell('git diff')]).observations).toHaveLength(1);
  });
  it('keeps mixed and unknown sources, preserves original indices and excludes summarize events', () => {
    expect(gateObservationPersistence([observation],[plan,shell('bun test')]).observations).toHaveLength(1);
    expect(gateObservationPersistence([observation],[plan,shell('ls')]).observations).toHaveLength(1);
    expect(gateObservationPersistence([observation],[]).observations).toHaveLength(1);
    expect(nonDurableSourceReason({...plan,type:'summarize'})).toBeNull();
    const result=gateObservationPersistence([{...observation,title:null},observation],[shell('cat cache.ts')]);
    expect(result.sourceIndices).toEqual([1]);
    expect(result.rejected).toEqual([{outputIndex:0,reason:'missing_title'}]);
  });
  it('rescues an emitted subtitle with body content without fabricating facts or overwriting fields', () => {
    ModeManager.getInstance().loadMode('code');
    const result=parseAgentXml('<observation><type>discovery</type><subtitle>Cache guard validated</subtitle><facts><fact>Original fact</fact></facts></observation>');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations[0].title).toBe('Cache guard validated');
    expect(result.observations[0].subtitle).toBe('Cache guard validated');
    expect(result.observations[0].facts).toEqual(['Original fact']);
    const metadata=parseAgentXml('<observation><type>discovery</type><subtitle>Just metadata</subtitle><concepts><concept>gotcha</concept></concepts></observation>');
    expect(metadata.valid && metadata.observations[0].title).toBeNull();
  });
});
