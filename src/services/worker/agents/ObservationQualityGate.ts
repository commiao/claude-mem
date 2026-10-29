/** Conservative source-provenance gates, shared by both workers and offline replay.
 * These rules recognize bookkeeping, not semantic truth. Unknown/mixed evidence
 * stays eligible; an output's title or a keyword such as "plan" never rejects it.
 */
import { parse } from 'shell-quote';
import type { ParsedObservation } from '../../../sdk/parser.js';
import { hasStorableTitle } from '../../sqlite/observations/store.js';

export interface ObservationSource {
  type?: string;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_output?: unknown;
}

export type QualityReason = 'plan_bookkeeping_only' | 'file_inventory_only' | 'retrieved_memory_only';
export interface ObservationGateDecision {
  outputIndex: number;
  reason: QualityReason | 'missing_title';
}

function objectOf(value: unknown): Record<string, any> | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : null;
}

function successfulStdout(source: ObservationSource): string | null {
  const output = objectOf(source.tool_response ?? source.tool_output);
  if (!output || typeof output.stdout !== 'string' || output.interrupted || output.is_error ||
      (typeof output.exit_code === 'number' && output.exit_code !== 0) ||
      (typeof output.exitCode === 'number' && output.exitCode !== 0)) return null;
  // Directory-listing hooks may append a cwd-reset notice on stderr. Any real
  // diagnostic must remain visible to the observer, even with a zero exit code.
  const stderr = String(output.stderr ?? '').replace(/^Shell cwd was reset to .*$/gm, '').trim();
  return stderr ? null : output.stdout;
}

/** Only a complete allowlisted shell pipeline is an inventory. No execution. */
function inventoryCommand(command: string): boolean {
  // Expansions/redirections can execute arbitrary commands. A discarded error
  // stream is allowed only because successfulStdout separately vetoes errors.
  const text = command.replace(/2>\s*\/dev\/null\b/g, '');
  if (/[`$<>\n\r]/.test(text)) return false;
  let tokens: ReturnType<typeof parse>;
  try { tokens = parse(text); } catch { return false; }
  let segment: string[] = [], inventory = false, pipeFromInventory = false;
  const accept = () => {
    if (!segment.length) return false;
    const [name, ...args] = segment;
    segment = [];
    if (args.some(a=>['--help','--version'].includes(a))) return false;
    if (['ls', 'find', 'wc'].includes(name)) {
      if (name === 'find' && args.some(a => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls'].includes(a))) return false;
      inventory = true;
      return true;
    }
    if (name === 'cd') return !pipeFromInventory && args.length === 1;
    // A filter with filename arguments would read NEW evidence, even after
    // `ls`. Only stdin-only forms downstream of an inventory are harmless.
    if (!pipeFromInventory) return false;
    if (name === 'head' || name === 'tail') return args.length===0 ||
      (args.length===1 && /^-\d+$/.test(args[0])) ||
      (args.length===2 && ['-n','-c'].includes(args[0]) && /^\d+$/.test(args[1]));
    if (name === 'sort') return args.every(a=>/^-[rnufhV]+$/.test(a));
    if (name === 'uniq') return args.every(a=>/^-[cdu]+$/.test(a));
    if (name === 'grep') {
      const patterns=args.filter(a=>!/^-[ivnEc]+$/.test(a));
      return patterns.length===1 && !patterns[0].startsWith('-');
    }
    // A sed substitution reformats names; sed file reads/writes/execs do not.
    if (name === 'sed') return args.length === 1 && /^s([^\w\s]).*\1.*\1[g0-9]*$/.test(args[0]);
    return false;
  };
  for (const token of tokens) {
    if (typeof token === 'string') segment.push(token);
    else if ('op' in token && typeof token.op === 'string' && ['|', '&&', ';'].includes(token.op)) {
      if (!accept()) return false;
      pipeFromInventory = token.op === '|' && inventory;
    } else return false;
  }
  return accept() && inventory;
}

function archiveDumpPrintsOnly(command: string): boolean {
  // Deliberately recognize only the legacy one-line dump convention. An
  // additional print of a calculation/diagnosis makes this mixed evidence.
  // Multiline/dynamic printing is unknown, so it is never silently rejected.
  const prints=command.split(/\r?\n/).filter(line=>/\bprint\s*\(/.test(line));
  return prints.length>0 && prints.every(line=>
    /^\s*print\(\s*body\s*\)\s*$/.test(line) ||
    (/\bprint\(f["']/.test(line) && /#{4,}/.test(line) && /\{body\[/.test(line)) ||
    (/^\s*for\s+g\s+in\s+x\[["']edges["']\]\s*:\s*print\(f["']/.test(line) && /g\[["']fact["']\]/.test(line)));
}

export function nonDurableSourceReason(source: ObservationSource): QualityReason | null {
  if (source.type && source.type !== 'observation') return null;
  const tool = source.tool_name ?? '';
  const input = objectOf(source.tool_input);
  // Explicit tool identity, never a substring in a natural-language body.
  if (/^(?:update_plan|TodoWrite|mcp__\w+__update_plan)$/i.test(tool) && input) {
    return 'plan_bookkeeping_only';
  }
  if (!['Bash', 'exec_command'].includes(tool) || !input) return null;
  const command = input.command ?? input.cmd;
  if (typeof command !== 'string') return null;
  const stdout = successfulStdout(source);
  if (stdout === null) return null;
  if (inventoryCommand(command)) return 'file_inventory_only';
  // Legacy campaign viewers print episode_body excerpts under explicit memory
  // headers. The numeric ids belong to that viewer, NOT our local SQLite ids.
  // Require both provenance in the reader and a dump-shaped response. Fresh
  // analysis without those headers, or another live record, remains eligible.
  if (/\[['"]episode_body['"]\]/.test(command) && archiveDumpPrintsOnly(command) &&
      /^(?:\s*ok\s*)?\s*#{4,}[^\r\n]*\bobs\s+\d+\s*\r?\n\[(?:FEATURE|BUGFIX|REFACTOR|CHANGE|DISCOVERY|DECISION|SECURITY_ALERT|SECURITY_NOTE|SENSITIVE)\]/i.test(stdout)) {
    return 'retrieved_memory_only';
  }
  return null;
}

export function gateObservationPersistence<T extends ParsedObservation>(
  observations: T[], sources: ReadonlyArray<ObservationSource>,
): { observations: T[]; sourceIndices: number[]; rejected: ObservationGateDecision[] } {
  const reasons = sources.map(nonDurableSourceReason);
  const sourceReason = reasons.length > 0 && reasons[0] && reasons.every(reason=>reason===reasons[0])
    ? reasons[0]! : null;
  const accepted: T[] = [], sourceIndices: number[] = [], rejected: ObservationGateDecision[] = [];
  observations.forEach((observation, outputIndex) => {
    const reason = sourceReason ?? (!hasStorableTitle(observation.title) ? 'missing_title' : null);
    if (reason) rejected.push({ outputIndex, reason });
    else { accepted.push(observation); sourceIndices.push(outputIndex); }
  });
  return { observations: accepted, sourceIndices, rejected };
}
