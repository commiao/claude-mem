/** Offline replay only: historical recorded answers, never calls a model. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { optimizeField } from '../src/services/worker/field-optimizer.js';
import { buildObservationPrompt } from '../src/sdk/prompts.js';
import { normalizeToolResult, serializeObservationField } from '../src/sdk/observation-field.js';
const audit = process.argv[2], transcripts = process.argv[3], output = process.argv[4];
if (!audit || !transcripts || !output) throw Error('Usage: bun --preload ./tests/preload.ts scripts/t0064-replay.ts AUDIT_DIR TRANSCRIPT_DIR OUTPUT_JSON');
const proof = JSON.parse(readFileSync(join(audit, 'actual-prompt-proof.json'), 'utf8'));
const oldFailures = new Set(proof.summary.actual_prompt_retruncations.map((r: any) => r.file));
const results: any[] = [];
for (const row of proof.results) {
  const events = readFileSync(join(transcripts, row.file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const c = events.find((e: any) => e.type === 'user').message.content;
  const text = typeof c === 'string' ? c : c.map((x: any) => x.text || '').join('\n');
  const raw = text.slice(text.indexOf('<payload>\n') + 10, text.lastIndexOf('\n</payload>'));
  const original = JSON.parse(raw);
  const normalized = normalizeToolResult(original);
  const answer = events.filter((e: any) => e.type === 'assistant' && e.message.model === 'claude_mem.observation').flatMap((e: any) => e.message.content).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n').trim();
  const result: any = { file: row.file, normalized: normalized !== original, avoidsCompression: raw.length > 16000 && serializeObservationField(normalized).length <= 16000, oldRetruncation: oldFailures.has(row.file) };
  if (answer && answer.length <= 16000) {
    try {
      const optimized = await optimizeField(original, async () => answer, { sessionDbId: 0, field: 'outcome', strict: true });
      const prompt = buildObservationPrompt({ id: 0, tool_name: 'Bash', tool_input: '{}', tool_output: JSON.stringify(optimized), created_at_epoch: 0 } as any, true);
      result.status = 'admitted'; result.elided = prompt.includes('<elided chars="');
      if (result.elided) throw Error('Silent elision regression');
    } catch (error) { result.status = 'deferred'; result.reason = (error as Error).message; }
  }
  results.push(result);
}
const summary = { samples: results.length, normalized: results.filter(x => x.normalized).length, avoidsCompression: results.filter(x => x.avoidsCompression).length, oldRetruncations: results.filter(x => x.oldRetruncation), admitted: results.filter(x => x.status === 'admitted').length, deferred: results.filter(x => x.status === 'deferred').length };
writeFileSync(output, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary, null, 2));
const middleProof = JSON.parse(readFileSync(join(audit, 'middle-proof.json'), 'utf8'));
const middleEvents = readFileSync(join(transcripts, middleProof.file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const middleContent = middleEvents.find((e: any) => e.type === 'user').message.content;
const middleText = typeof middleContent === 'string' ? middleContent : middleContent.map((x: any) => x.text || '').join('\n');
const middleRaw = middleText.slice(middleText.indexOf('<payload>\n') + 10, middleText.lastIndexOf('\n</payload>'));
const middleValue = JSON.parse(middleRaw);
const middleAnswer = middleEvents.filter((e: any) => e.type === 'assistant').flatMap((e: any) => e.message.content).map((x: any) => x.text || '').join('\n');
let middlePrompt = '', middleStatus = '';
try {
  const optimized = await optimizeField(middleValue, async () => middleAnswer, { sessionDbId: 0, field: 'outcome', strict: true });
  middlePrompt = buildObservationPrompt({ id: 0, tool_name: 'Bash', tool_input: '{}', tool_output: JSON.stringify(optimized), created_at_epoch: 0 } as any, true);
  middleStatus = 'admitted';
} catch { middleStatus = 'deferred'; }
const markerResult = { file: middleProof.file, status: middleStatus, markers: middleProof.markers.map((m: any) => ({ marker: m.marker, original: middleRaw.includes(m.marker), recordedAnswer: middleAnswer.includes(m.marker), finalPrompt: middlePrompt.includes(m.marker) })) };
writeFileSync(output, JSON.stringify({ summary, markerResult, results }, null, 2));
console.log(JSON.stringify(markerResult, null, 2));
