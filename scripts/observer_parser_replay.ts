/** Pure parser comparison of saved outputs. Never generate or store memories. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const [evidence, baseline, candidate, out] = process.argv.slice(2);
if (!evidence || !baseline || !candidate || !out) {
  throw new Error('usage: observer_parser_replay.ts EVIDENCE BASELINE_SOURCE CANDIDATE_SOURCE OUT');
}
process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'mem-check-replay-'));
process.env.CLAUDE_MEM_MODES_DIR = join(candidate, 'plugin/modes');
process.env.CLAUDE_MEM_LOG_LEVEL = 'ERROR';
for (const root of [baseline, candidate]) {
  const { ModeManager } = await import(pathToFileURL(join(root, 'src/services/domain/ModeManager.ts')).href);
  ModeManager.getInstance().loadMode('code');
}
const beforeParser = await import(pathToFileURL(join(baseline, 'src/sdk/parser.ts')).href);
const afterParser = await import(pathToFileURL(join(candidate, 'src/sdk/parser.ts')).href);
const historical = JSON.parse(readFileSync(join(evidence, 'historical-results.json'), 'utf8'));
const selection = JSON.parse(readFileSync(join(evidence, 'selection.json'), 'utf8'));
const rows = selection.sampled.map((source: any) => {
  const raw = historical[source.case_id].raw_text;
  const before = beforeParser.parseAgentXml(raw);
  const after = afterParser.parseAgentXml(raw);
  const fields = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'];
  return { id: source.case_id, kind: source.kind, before_valid: before.valid, after_valid: after.valid,
    accepted_summary_fields_unchanged: source.kind === 'summary' && before.valid && after.valid
      ? fields.every(k => (before.summary?.[k] ?? null) === (after.summary?.[k] ?? null)) : null,
    observations_unchanged: source.kind === 'observation' && before.valid && after.valid
      ? JSON.stringify(before.observations) === JSON.stringify(after.observations) : null };
});
const counts: Record<string, unknown> = {};
for (const kind of ['observation', 'summary']) {
  const selected = rows.filter((r: any) => r.kind === kind);
  counts[kind] = { cases: selected.length, before_valid: selected.filter((r: any) => r.before_valid).length,
    after_valid: selected.filter((r: any) => r.after_valid).length,
    newly_rejected: selected.filter((r: any) => r.before_valid && !r.after_valid).length,
    accepted_content_changed: selected.filter((r: any) => r.accepted_summary_fields_unchanged === false || r.observations_unchanged === false).length };
}
writeFileSync(out, JSON.stringify({ method: 'offline parser replay; no model invocation', counts, rows }, null, 2));
console.log(JSON.stringify(counts));
// A newly rejected historical reply is a visible policy change to inspect.
// Silently changing the content of an accepted reply is a compatibility failure.
if (rows.some((r: any) => r.accepted_summary_fields_unchanged === false || r.observations_unchanged === false)) {
  process.exitCode = 1;
}
