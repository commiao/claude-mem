/** Offline bridge to the real business prompts/parser. Never creates a worker or opens its database. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [action, dataDir, modeDir] = process.argv.slice(2);
if (!['build', 'parse'].includes(action) || !dataDir || !modeDir) throw new Error('invalid bridge arguments');
process.env.CLAUDE_MEM_DATA_DIR = resolve(dataDir);
process.env.CLAUDE_MEM_MODES_DIR = resolve(modeDir);
const { ModeManager } = await import('../../src/services/domain/ModeManager.js');
const mode = ModeManager.getInstance().loadMode('code');
const input = JSON.parse(readFileSync(0, 'utf8'));
if (action === 'parse') {
  const { parseAgentXml } = await import('../../src/sdk/parser.js');
  console.log(JSON.stringify(input.map((row: {id: string; text: string}) =>
    ({id: row.id, parsed: parseAgentXml(row.text)}))));
} else {
  const { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } = await import('../../src/sdk/prompts.js');
  const prepared = input.map((row: any) => {
    if (row.request) return {...row, system: row.request.system,
      prompts: [row.request.messages.map((m: any) => m.content).join('\n\n')], captured_request: true};
    const system = buildInitPrompt(row.project || 'observer-bench', row.id, row.user_prompt || '', mode) +
      '\nThis request is an independent batch. Use only the supplied records. If none contains durable facts, output <skip_summary reason="no durable facts"/>.';
    const prompts = row.kind === 'summary'
      ? [buildSummaryPrompt({id: 0, memory_session_id: null, project: row.project || 'observer-bench',
          user_prompt: row.user_prompt || '', last_assistant_message: row.last_assistant_message || ''}, mode) +
          '\nPersisted observations (bounded most recent subset):\n' + JSON.stringify(row.persisted_observations || [])]
      : row.records.map((r: any, i: number) => buildObservationPrompt({id: 0,
          recoveryTaskId: `${row.id}:${i}`, tool_name: r.tool_name, tool_input: r.tool_input,
          tool_output: r.tool_output, created_at_epoch: Date.parse(r.occurred_at || '2026-01-01T00:00:00Z'),
          cwd: r.cwd}, Infinity));
    return {...row, system, prompts, captured_request: false};
  });
  console.log(JSON.stringify(prepared));
}
