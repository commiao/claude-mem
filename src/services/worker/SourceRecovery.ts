import type { Database } from 'bun:sqlite';
import { createReadStream, statSync, openSync, readSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { RecoveryLedger } from './RecoveryLedger.js';

type SourceInput = {sessionId:string;toolUseId?:string;transcriptPath?:string;platform?:string;cwd:string};
type SourceRow = {content_session_id:string;tool_use_id:string;source_path:string;platform:string;cwd:string;source_tool_id?:string|null};
type Payload = {contentSessionId:string;toolUseId:string;toolName:string;toolInput:unknown;toolResponse:unknown;cwd:string;platformSource:string};
type IngestResult = {ok:boolean;status?:string;reason?:string};

export function initializeSourceRecovery(db: Database): void {
  new RecoveryLedger(db);
  db.exec(`CREATE TABLE IF NOT EXISTS source_recovery_control (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('hold','active')));
    CREATE TABLE IF NOT EXISTS source_event_refs (
      content_session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, source_path TEXT NOT NULL,
      platform TEXT NOT NULL, cwd TEXT NOT NULL, registered_at INTEGER NOT NULL, last_attempt_at INTEGER NOT NULL DEFAULT 0, source_tool_id TEXT,
      PRIMARY KEY(content_session_id, tool_use_id));`);
  const columns=db.query('PRAGMA table_info(source_event_refs)').all() as {name:string}[];
  if(!columns.some(c=>c.name==='source_tool_id'))db.exec('ALTER TABLE source_event_refs ADD COLUMN source_tool_id TEXT');
}

/** Called by hooks before worker submission. Holds contain pointers only. */
export function registerSourcePointer(db: Database, input: SourceInput): 'forward' | 'held' {
  const exists=db.query("SELECT 1 FROM sqlite_master WHERE name='source_recovery_control'").get();
  if (!exists) return 'forward';
  const control=db.query('SELECT mode FROM source_recovery_control WHERE id=1').get() as {mode:string}|null;
  if (!control) return 'forward';
  if (!input.toolUseId || !input.transcriptPath || !isAbsolute(input.transcriptPath)) return 'forward';
  if (!['codex','claude','claude-code'].includes(input.platform??'')) return 'forward';
  try {if(!statSync(input.transcriptPath).isFile())return 'forward';} catch {return 'forward';}
  // FULL is intentional: acknowledgement is issued only after the source
  // reference transaction is durable. Original content remains in the IDE file.
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
  if(control.mode==='hold' && !hasRecordedUse(input.transcriptPath,input.toolUseId,input.platform!)) return 'forward';
  db.query('INSERT OR IGNORE INTO source_event_refs (content_session_id,tool_use_id,source_path,platform,cwd,registered_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    input.sessionId,input.toolUseId,input.transcriptPath,input.platform!,input.cwd,Date.now());
  return control.mode==='hold'?'held':'forward';
}

function codexParts(entry:any):any[] {
  if(entry.type==='response_item')return [entry.payload];
  if(entry.type!=='event_msg'||entry.payload?.type!=='item_completed')return [];
  const item=entry.payload.item;
  if(!item?.id)return [];
  // Native PostToolUse IDs refer to completed desktop items (exec-/mcp-),
  // not the outer functions.exec response_item call ID.
  if(item.type==='CommandExecution')return [{type:'source_complete',call_id:item.id,name:'Bash',
    input:{command:item.command,cwd:item.cwd},output:{stdout:item.stdout,stderr:item.stderr,exit_code:item.exit_code}}];
  if(item.type==='McpToolCall')return [{type:'source_complete',call_id:item.id,name:`mcp__${item.server}__${item.tool}`,
    input:item.arguments,output:item.result}];
  return [];
}

/** Native hooks can run before the IDE appends the result. Register only
 * an existing source call/completed item; keep the reference pending until
 * the result appears. No model submission or completion receipt occurs early.
 * An input outside this bounded tail falls back to the old worker. */
function hasRecordedUse(file:string,id:string,platform:string):boolean {
  const fd=openSync(file,'r');
  try {
    const size=statSync(file).size,start=Math.max(0,size-4*1024*1024);
    const bytes=Buffer.alloc(size-start);const read=readSync(fd,bytes,0,bytes.length,start);
    const lines=bytes.subarray(0,read).toString('utf8').split('\n');
    if(start)lines.shift();lines.pop();
    let use=false,result=false;
    for(const line of lines){
      if(!line.trim())continue;
      let e:any;try{e=JSON.parse(line);}catch{continue;}
      const parts=platform==='codex'?codexParts(e):(Array.isArray(e.message?.content)?e.message.content:[]);
      for(const p of parts){if(!p||(p.call_id??p.tool_use_id??p.id)!==id)continue;
        if(p.type==='source_complete'){use=true;result=true;}
        if(['function_call','custom_tool_call','tool_use'].includes(p.type))use=true;
        if(['function_call_output','custom_tool_call_output','tool_result'].includes(p.type))result=true;
      }
    }
    return use;
  }finally{closeSync(fd);}
}

function parseInput(value: unknown): unknown {
  if(typeof value!=='string')return value;
  try{return JSON.parse(value);}catch{return value;}
}

/** Rebuild complete tool pairs from the durable IDE transcript. No tool runs. */
export async function readReferencedEvents(rows: SourceRow[], submit:(payload:Payload)=>Promise<void>): Promise<number> {
  if(!rows.length)return 0;
  const first=rows[0];
  const wanted=new Map(rows.map(row=>[row.source_tool_id??row.tool_use_id,row]));
  const calls=new Map<string,{name:string;input:unknown}>();
  const stream=createReadStream(first.source_path);
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  let count=0;
  try {
    for await(const line of lines){
      if(!line.trim())continue;
      const entry=JSON.parse(line);
      // Forked transcripts can contain copied parent metadata and child
      // metadata in the same file. Attribution comes from the native hook's
      // registered (parent session, exact source path, stable item ID), not
      // from whichever session_meta happens to precede the copied history.
      const parts=first.platform==='codex'
        ? codexParts(entry)
        : (Array.isArray(entry.message?.content)?entry.message.content:[]);
      for(const part of parts){
        if(!part)continue;
        const id=part.call_id??part.tool_use_id??part.id;
        if(!wanted.has(id))continue;
        if(part.type==='source_complete'){
          const row=wanted.get(id)!;
          await submit({contentSessionId:row.content_session_id,toolUseId:row.tool_use_id,toolName:part.name,toolInput:part.input,toolResponse:part.output,cwd:row.cwd,platformSource:row.platform});
          wanted.delete(id);count++;if(!wanted.size)return count;
        } else if(['function_call','custom_tool_call','tool_use'].includes(part.type)) {
          calls.set(id,{name:part.name,input:parseInput(part.arguments??part.input)});
        } else if(['function_call_output','custom_tool_call_output','tool_result'].includes(part.type)) {
          const call=calls.get(id),row=wanted.get(id)!;
          // Missing use may be a truncated/forked source. Keep the reference
          // pending instead of treating it as processed.
          if(!call)continue;
          await submit({contentSessionId:row.content_session_id,toolUseId:row.tool_use_id,toolName:call.name,
            toolInput:call.input,toolResponse:part.output??part.content,cwd:row.cwd,platformSource:row.platform});
          wanted.delete(id);calls.delete(id);count++;
          if(!wanted.size)return count;
        }
      }
    }
    return count;
  } finally {lines.close();stream.destroy();}
}

export async function recoverSourcePass(db:Database,ingest:(p:Payload)=>Promise<IngestResult>,limit=100):Promise<{selected:number;submitted:number;errors:number}> {
  const rows=db.query(`SELECT r.* FROM source_event_refs r LEFT JOIN observation_receipts c
    ON c.content_session_id=r.content_session_id AND c.tool_use_id=r.tool_use_id
    WHERE c.tool_use_id IS NULL ORDER BY r.last_attempt_at,r.registered_at,r.rowid LIMIT ?`).all(limit) as SourceRow[];
  const groups=new Map<string,SourceRow[]>();
  for(const row of rows){const key=JSON.stringify([row.source_path,row.content_session_id]);const list=groups.get(key)??[];list.push(row);groups.set(key,list);}
  let submitted=0,errors=0;
  for(const group of groups.values()){
    for(const row of group)db.query('UPDATE source_event_refs SET last_attempt_at=? WHERE content_session_id=? AND tool_use_id=?').run(Date.now(),row.content_session_id,row.tool_use_id);
    try {
    const count=await readReferencedEvents(group,async payload=>{
      const result=await ingest(payload);
      if(!result.ok)throw new Error('Source recovery ingestion failed');
      if(result.status==='skipped')new RecoveryLedger(db).commit(payload.contentSessionId,[payload.toolUseId],'skipped',()=>{});
    });
    submitted+=count;if(count<group.length)errors++;
    } catch {errors++;}
  }
  return {selected:rows.length,submitted,errors};
}

/** Start only after DB and provider dispatch initialization. Never await model
 * completion at boot. One bounded pass at a time; normal in-process dedup keeps
 * a still-processing event from entering the model queue twice. */
export function startSourceRecovery(db:Database,ingest:(p:Payload)=>Promise<IngestResult>,onError:(error:unknown)=>void):()=>void {
  initializeSourceRecovery(db);
  db.query("INSERT INTO source_recovery_control VALUES(1,'active') ON CONFLICT(id) DO UPDATE SET mode='active'").run();
  let stopped=false,running=false;
  const tick=async()=>{if(stopped||running)return;running=true;try{const result=await recoverSourcePass(db,async p=>{if(stopped)throw new Error('Recovery stopping');return ingest(p);});if(result.errors)onError(new Error(`${result.errors} source groups remain unresolved; references retained`));}catch(error){onError(error);}finally{running=false;}};
  const timer=setInterval(()=>{void tick();},30000);timer.unref();
  void tick();
  return ()=>{stopped=true;clearInterval(timer);};
}
