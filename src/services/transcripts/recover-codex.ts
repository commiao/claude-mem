import { Database } from 'bun:sqlite';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface RecoveryEvent {
  contentSessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd: string;
  platformSource: 'codex';
  timestamp: string;
}

/** Read original records from the beginning to reconstruct pairs and cwd.
 * The durable cursor is the set of completed event IDs, NOT a read offset.
 * This intentionally trades scanning cost for safe recovery across file forks.
 */
export async function* readCodexEvents(file: string): AsyncGenerator<RecoveryEvent> {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let sessionId = '', cwd = '';
  const pending = new Map<string, { name: string; input: unknown; cwd: string }>();
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      // Reject malformed/truncated JSON; never silently advance past it.
      const entry = JSON.parse(line);
      const p = entry.payload;
      if (entry.type === 'session_meta') {
        if (sessionId && sessionId !== p.id) throw new Error('Session identity changed within transcript');
        sessionId = p.id; cwd = p.cwd ?? cwd;
      }
      if (entry.type === 'turn_context') cwd = p.cwd ?? cwd;
      if (entry.type !== 'response_item' || !p) continue;
      if (['function_call', 'custom_tool_call'].includes(p.type)) {
        if (p.call_id && p.name) pending.set(p.call_id, { name: p.name, input: p.arguments ?? p.input, cwd });
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        const call = pending.get(p.call_id);
        if (!call) throw new Error(`Unpaired tool result: ${p.call_id}`);
        if (!sessionId || !call.cwd) throw new Error('Missing session identity or cwd');
        let toolInput = call.input;
        if (typeof toolInput === 'string') { try { toolInput = JSON.parse(toolInput); } catch {} }
        yield { contentSessionId: sessionId, toolUseId: p.call_id, toolName: call.name,
          toolInput, toolResponse: p.output, cwd: call.cwd, platformSource: 'codex', timestamp: entry.timestamp };
        pending.delete(p.call_id);
      }
    }
  } finally { lines.close(); input.destroy(); }
}

export function isCompleted(db: Database, event: RecoveryEvent): boolean {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_receipts'").get();
  return !!exists && !!db.query('SELECT 1 FROM observation_receipts WHERE content_session_id=? AND tool_use_id=?')
    .get(event.contentSessionId, event.toolUseId);
}

/** A bounded replay pass. Submission success is not completion. The caller
 * waits for the durable receipt; a failed/unconfirmed item stops the pass.
 * Selection must exclude pre-ledger history unless separately reconciled.
 */
export async function replayUncompleted(
  events: AsyncIterable<RecoveryEvent>,
  options: {
    completed: (event: RecoveryEvent) => boolean;
    select: (event: RecoveryEvent) => boolean;
    submit: (event: RecoveryEvent) => Promise<void>;
    waitForCompletion: (event: RecoveryEvent) => Promise<boolean>;
    limit: number;
  },
): Promise<{ submitted: number; completed: number }> {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('Positive replay limit required');
  let submitted = 0, completed = 0;
  const seen = new Set<string>();
  for await (const event of events) {
    if (!options.select(event)) continue;
    const key = JSON.stringify([event.contentSessionId, event.toolUseId]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (options.completed(event)) continue;
    await options.submit(event);
    submitted++;
    if (!await options.waitForCompletion(event) || !options.completed(event)) {
      throw new Error(`Replay stopped without durable completion: ${event.toolUseId}`);
    }
    completed++;
    if (submitted >= options.limit) break;
  }
  return { submitted, completed };
}

// Audit only: no HTTP, no DB writes, no new copy of raw inputs. Actual submission
// requires an established first-deployment boundary; historical IDs are unknown.
if (import.meta.main) {
  const [dbPath, ...files] = process.argv.slice(2);
  if (!dbPath || !files.length) throw new Error('Usage: bun recover-codex.ts DB_PATH TRANSCRIPT...');
  const db = new Database(dbPath, { readonly: true });
  const seen = new Set<string>();
  let completed = 0, unconfirmed = 0;
  try {
    for (const file of files) for await (const event of readCodexEvents(file)) {
      const key = JSON.stringify([event.contentSessionId, event.toolUseId]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isCompleted(db, event)) completed++; else unconfirmed++;
    }
    console.log(JSON.stringify({ mode: 'audit', completed, unconfirmed,
      warning: 'Unconfirmed includes historical events predating receipts; not a replay authorization.' }));
  } finally { db.close(); }
}
