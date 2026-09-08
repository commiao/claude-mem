import { readReferencedEvents } from '../worker/SourceRecovery.js';
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
  platformSource: string;
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

/** Default is read-only audit. --replay is an explicit, bounded operation.
 * --since must be an independently established boundary after receipt-enabled
 * deployment; never use a guessed historical timestamp to seed a cursor.
 */
if (import.meta.main) {
  const args = process.argv.slice(2);
  const replay = args.includes('--replay');
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${name}`);
    return args[i + 1];
  };
  const since = option('--since');
  const expectedPid = Number(option('--worker-pid'));
  const port = Number(option('--port') ?? '37701');
  const limit = Number(option('--limit') ?? '20');
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--replay') continue;
    if (['--since','--worker-pid','--port','--limit'].includes(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
    positional.push(args[i]);
  }
  const [dbPath, ...files] = positional;
  if (!dbPath || !files.length) throw new Error('Usage: bun recover-codex.ts DB_PATH TRANSCRIPT... [--replay --since ISO_DATE --worker-pid PID --limit N]');
  const sinceEpoch = since ? Date.parse(since) : undefined;
  if (since && !Number.isFinite(sinceEpoch)) throw new Error('Invalid --since timestamp');
  if (replay && (!since || !Number.isInteger(expectedPid) || expectedPid < 1)) throw new Error('Replay requires a verified --since boundary and --worker-pid');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const db = new Database(dbPath, { readonly: true });
  const selected = (event: RecoveryEvent) => {
    if (sinceEpoch === undefined) return true;
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) throw new Error('Missing or invalid event timestamp');
    return time >= sinceEpoch;
  };
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Replay limit must be 1..1000');
  const events = async function* () {
    for (const file of files) {
      if (!replay) {yield* readCodexEvents(file);continue;}
      // Native hook IDs can differ from outer functions.exec IDs. Manual
      // replay must use the same registered source IDs as automatic recovery.
      if (!db.query("SELECT 1 FROM sqlite_master WHERE name='source_event_refs'").get()) throw new Error('No registered source cursor; refusing historical replay');
      if (!db.query('SELECT 1 FROM source_event_refs WHERE source_path=? LIMIT 1').get(file)) throw new Error('Source is not registered; reconcile historical input separately');
      const rows=db.query(`SELECT r.* FROM source_event_refs r LEFT JOIN observation_receipts c USING(content_session_id,tool_use_id)
        WHERE r.source_path=? AND r.registered_at>=? AND c.tool_use_id IS NULL ORDER BY r.registered_at LIMIT ?`).all(file,sinceEpoch??0,limit) as any[];
      const mapped=new Map(rows.map(r=>[r.tool_use_id,r]));
      const recovered:RecoveryEvent[]=[];
      const count=await readReferencedEvents(rows,async p=>{recovered.push({...p,timestamp:new Date(mapped.get(p.toolUseId).registered_at).toISOString()});});
      if(count!==rows.length)throw new Error('Some registered source results are unavailable; pointers retained');
      yield* recovered;
    }
  };
  const seen = new Set<string>();
  let completed = 0, unconfirmed = 0;
  try {
    // Validate all source files before any submission. Unknown historical IDs
    // remain unconfirmed; this program never silently seeds them as completed.
    for await (const event of events()) {
      if (!selected(event)) continue;
      const key = JSON.stringify([event.contentSessionId, event.toolUseId]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isCompleted(db, event)) completed++; else unconfirmed++;
    }
    console.log(JSON.stringify({ mode: 'audit', completed, unconfirmed,
      warning: 'Unconfirmed includes historical events predating receipts; not proof of missing observations.' }));
    if (replay) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_receipts'").get()) {
        throw new Error('Receipt-enabled worker has not initialized this database; refusing replay');
      }
      const base = `http://127.0.0.1:${port}`;
      const verifyWorker = async () => {
        const response = await fetch(base + '/api/health', {signal: AbortSignal.timeout(5000)});
        if (!response.ok) throw new Error('Worker health failed');
        const health = await response.json() as {pid:number; initialized:boolean};
        if (health.pid !== expectedPid || !health.initialized) throw new Error('Worker identity changed or is unready; stop and recheck recovery boundary');
      };
      await verifyWorker();
      const result = await replayUncompleted(events(), {
        completed: event => isCompleted(db,event), select:selected, limit,
        submit: async event => {
          await verifyWorker();
          const response = await fetch(base + '/api/sessions/observations', {
            method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),
            body:JSON.stringify({contentSessionId:event.contentSessionId,tool_use_id:event.toolUseId,
              tool_name:event.toolName,tool_input:event.toolInput,tool_response:event.toolResponse,
              cwd:event.cwd,platformSource:event.platformSource}),
          });
          if (!response.ok) throw new Error(`Observation submission failed: HTTP ${response.status}`);
          const body = await response.json() as {status?:string};
          if (body.status === 'skipped') throw new Error('Observation excluded by current policy; receipt remains unchanged');
        },
        waitForCompletion: async event => {
          const deadline = Date.now() + 120000;
          while (Date.now() < deadline) {
            await verifyWorker();
            if (isCompleted(db,event)) return true;
            await new Promise(resolve=>setTimeout(resolve,1000));
          }
          return false;
        },
      });
      console.log(JSON.stringify({mode:'replay',...result}));
    }
  } finally { db.close(); }
}
