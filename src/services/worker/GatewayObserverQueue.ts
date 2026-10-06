/** Business batching/persistence only. The gateway owns all model execution limits. */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { DatabaseManager } from './DatabaseManager.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { parseAgentXml } from '../../sdk/parser.js';
import { ModeManager } from '../domain/ModeManager.js';
import { extractObservationFileEvidence, sanitizeObservationFiles, normalizeSummaryForStorage, attachObservationFilesToSummary } from './agents/ResponseProcessor.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

export function gatewayQueueEnabled(): boolean { return !!process.env.CLAUDE_MEM_LLM_QUEUE_URL; }
export interface QueueConfig { url: string; tokenFile: string; maxItems: number; maxBytes: number; }
export function queueConfig(): QueueConfig {
  const url = new URL(process.env.CLAUDE_MEM_LLM_QUEUE_URL!);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('observer_queue_requires_private_gateway_origin');
  }
  const tokenFile = process.env.CLAUDE_MEM_LLM_QUEUE_TOKEN_FILE;
  if (!tokenFile) throw new Error('observer_queue_token_file_required');
  const maxItems = Number(process.env.CLAUDE_MEM_LLM_BATCH_ITEMS || 20);
  const maxBytes = Number(process.env.CLAUDE_MEM_LLM_BATCH_BYTES || 64000);
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 20 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 256000) throw new Error('invalid_observer_batch_budget');
  return {url: url.origin, tokenFile, maxItems, maxBytes};
}

export function initializeQueueTables(db: ReturnType<DatabaseManager['getConnection']>): void {
  db.run(`CREATE TABLE IF NOT EXISTS observer_queue_inputs (
    task_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'observation', context TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS observer_queue_batches (
    id TEXT PRIMARY KEY, session_db_id INTEGER NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', result TEXT, receipt TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0)`);
  if (!(db.prepare('PRAGMA table_info(observer_queue_batches)').all() as any[]).some(c=>c.name==='checked_at')) {
    db.run('ALTER TABLE observer_queue_batches ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0');
  }
  db.run(`CREATE TABLE IF NOT EXISTS observer_queue_members (
    task_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL)`);
}

/** Save the immutable business context in the same transaction as source ingress. */
export function ownQueueInput(db: ReturnType<DatabaseManager['getConnection']>, taskId: string,
                              context: object, kind='observation'): void {
  initializeQueueTables(db);
  db.prepare('INSERT OR IGNORE INTO observer_queue_inputs(task_id,kind,context) VALUES(?,?,?)')
    .run(taskId, kind, JSON.stringify(context));
}

export class GatewayObserverQueue {
  private stopped = false;
  private loop?: Promise<void>;
  private abort = new AbortController();
  constructor(private manager: DatabaseManager, private config: QueueConfig,
              private fetcher: typeof fetch = fetch) {
    initializeQueueTables(manager.getConnection());
  }
  start(): void { this.loop = this.run(); }
  async stop(): Promise<void> { this.stopped = true; this.abort.abort(); await this.loop; }

  private async request(path: string, body: object, key?: string): Promise<any> {
    const token = readFileSync(this.config.tokenFile, 'utf8').trim();
    if (!token) throw new Error('empty_observer_gateway_token');
    const response = await this.fetcher(this.config.url+path, {
      method:'POST', redirect:'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,
               ...(key ? {'Idempotency-Key':key} : {})}, body:JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`observer_queue_http_${response.status}`);
    const value: any = await response.json();
    if (value.version !== 1) throw new Error('observer_queue_contract_mismatch');
    return value;
  }

  /** One atomic, count/byte-bounded batch; no previous model conversation enters the body. */
  prepareBatch(): boolean {
    const db = this.manager.getConnection();
    return db.transaction(() => {
      const candidates = db.prepare(`SELECT t.id,t.session_db_id,t.content_session_id,t.payload,
        t.enqueued_at_epoch,i.context,i.kind FROM observer_tasks t JOIN observer_queue_inputs i ON i.task_id=t.id
        LEFT JOIN observer_queue_members m ON m.task_id=t.id
        WHERE t.state='queued' AND m.task_id IS NULL
        AND (i.kind!='summary' OR NOT EXISTS (SELECT 1 FROM observer_tasks older
          WHERE older.session_db_id=t.session_db_id AND older.enqueued_at_epoch<t.enqueued_at_epoch
          AND older.state IN ('queued','running','reconciliation'))) ORDER BY t.enqueued_at_epoch,t.id LIMIT 200`).all() as any[];
      if (!candidates.length) return false;
      const first = candidates[0], context = JSON.parse(first.context), firstInput = JSON.parse(first.payload);
      const mode = ModeManager.getInstance().getActiveMode();
      const system = buildInitPrompt(context.project, first.content_session_id, context.userPrompt || '', mode) +
        '\nThis request is an independent batch. Use only the supplied records. If none contains durable facts, output <skip_summary reason="no durable facts"/>.';
      const selected: any[] = [], prompts: string[] = [];
      const body: any = {model:'claude_mem.observation', max_tokens:4096, system,
        messages:[{role:'user',content:''}]};
      for (const row of candidates) {
        if (row.session_db_id !== first.session_db_id) continue;
        if (row.context !== first.context || row.kind !== first.kind) break;
        if (selected.length >= (first.kind === 'summary' ? 1 : this.config.maxItems)) break;
        const input = JSON.parse(row.payload);
        if (input.prompt_number !== firstInput.prompt_number || input.agentId !== firstInput.agentId ||
            input.agentType !== firstInput.agentType) break;
        let prompt = first.kind === 'summary'
          ? buildSummaryPrompt({id:row.session_db_id,memory_session_id:null,project:context.project,
              user_prompt:context.userPrompt || '',last_assistant_message:input.last_assistant_message || ''}, mode)
          : buildObservationPrompt({id:0,recoveryTaskId:row.id,tool_name:input.tool_name,
              tool_input:input.tool_input,tool_output:input.tool_response,
              created_at_epoch:row.enqueued_at_epoch,cwd:input.cwd}, Number.POSITIVE_INFINITY);
        if (first.kind === 'summary') {
          const prior = db.prepare(`SELECT title,facts,narrative FROM observations WHERE memory_session_id=
            (SELECT memory_session_id FROM sdk_sessions WHERE id=?) ORDER BY created_at_epoch DESC,id DESC LIMIT 20`)
            .all(first.session_db_id);
          const bounded: unknown[] = [];
          for (const fact of prior) {
            if (Buffer.byteLength(JSON.stringify([...bounded,fact])) > 12000) break;
            bounded.push(fact);
          }
          prompt += '\nPersisted observations (bounded most recent subset):\n'+JSON.stringify(bounded);
        }
        body.messages[0].content = [...prompts,prompt].join('\n\n');
        if (Buffer.byteLength(JSON.stringify(body)) > this.config.maxBytes) {
          if (!selected.length) {
            db.prepare("UPDATE observer_tasks SET state='failed',outcome='batch_input_over_budget',version=version+1 WHERE id=?")
              .run(row.id);
            return true;
          }
          break;
        }
        selected.push(row); prompts.push(prompt);
      }
      body.messages[0].content = prompts.join('\n\n');
      const raw = JSON.stringify(body);
      const id = 'cmq-'+createHash('sha256').update(JSON.stringify(selected.map(r=>r.id))).digest('hex');
      db.prepare('INSERT INTO observer_queue_batches(id,session_db_id,body,created_at) VALUES(?,?,?,?)')
        .run(id,first.session_db_id,raw,Date.now());
      for (const row of selected) {
        db.prepare('INSERT INTO observer_queue_members(task_id,batch_id) VALUES(?,?)').run(row.id,id);
        db.prepare("UPDATE observer_tasks SET state='running',version=version+1 WHERE id=?").run(row.id);
      }
      return true;
    })();
  }

  private members(id: string): any[] {
    return this.manager.getConnection().prepare(`SELECT t.*,i.context,i.kind FROM observer_tasks t
      JOIN observer_queue_members m ON m.task_id=t.id JOIN observer_queue_inputs i ON i.task_id=t.id
      WHERE m.batch_id=? ORDER BY t.enqueued_at_epoch,t.id`).all(id) as any[];
  }

  async processBatch(batch: any): Promise<void> {
    const db = this.manager.getConnection();
    if (batch.receipt) {
      const ack = await this.request('/v1/queue/ack', {business_key:'claude_mem.observation',
        idempotency_key:batch.id,receipt:JSON.parse(batch.receipt)});
      if (ack.job?.request_key !== batch.id || ack.job?.business_key !== 'claude_mem.observation' ||
          ack.job.business_receipt?.state !== JSON.parse(batch.receipt).state ||
          ack.job.business_receipt?.reference !== JSON.parse(batch.receipt).reference) {
        throw new Error('observer_business_ack_identity_mismatch');
      }
      db.prepare('UPDATE observer_queue_batches SET acknowledged=1 WHERE id=?').run(batch.id);
      return;
    }
    const rows = this.members(batch.id);
    const value = batch.state === 'pending'
      ? await this.request('/v1/queue/submit', {
          request:JSON.parse(batch.body),task_ids:rows.map(r=>r.id),scenario:'observer_batch',
        },batch.id)
      : await this.request('/v1/queue/status', {business_key:'claude_mem.observation',idempotency_key:batch.id});
    const job = value.job;
    if (!job || job.request_key !== batch.id || job.business_key !== 'claude_mem.observation') {
      throw new Error('observer_queue_identity_mismatch');
    }
    if (job.state === 'queued' || job.state === 'running') {
      db.prepare("UPDATE observer_queue_batches SET state='submitted' WHERE id=?").run(batch.id);
      return;
    }
    if (job.state !== 'succeeded') {
      if (!['failed','reconciliation'].includes(job.state)) throw new Error('invalid_observer_queue_state');
      db.transaction(() => {
        db.prepare('UPDATE observer_queue_batches SET state=?,error=? WHERE id=?')
          .run(job.state,JSON.stringify(job.error || {}),batch.id);
        if (job.state === 'failed') db.prepare('UPDATE observer_queue_batches SET receipt=? WHERE id=?')
          .run(JSON.stringify({state:'failed',reference:'sqlite:observer_queue_batches:'+batch.id}),batch.id);
        for (const row of rows) db.prepare('UPDATE observer_tasks SET state=?,version=version+1 WHERE id=?')
          .run(job.state === 'failed' ? 'failed' : 'reconciliation',row.id);
      })();
      return;
    }
    // Store the original model response before parsing. A business parser failure
    // must not authorize another model call or lose its paid result.
    db.prepare('UPDATE observer_queue_batches SET result=? WHERE id=?').run(JSON.stringify(job.response),batch.id);
    const text = (job.response.content || []).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');
    const parsed = parseAgentXml(text, batch.id);
    if (!parsed.valid || job.response.stop_reason !== 'end_turn') {
      db.transaction(() => {
        db.prepare("UPDATE observer_queue_batches SET state='reconciliation',error='invalid_model_output' WHERE id=?").run(batch.id);
        this.manager.getObserverTaskStore().needsReconciliation(rows.map(r=>r.id));
      })();
      return;
    }
    const first = rows[0], context = JSON.parse(first.context), input = JSON.parse(first.payload);
    const store = this.manager.getSessionStore();
    // The database relation is stable; it is not a provider conversation ID.
    const memoryId = store.ensureMemorySessionIdRegistered(batch.session_db_id,
      'queue-'+first.content_session_id, getWorkerPort()) || 'queue-'+first.content_session_id;
    const evidence = extractObservationFileEvidence(rows.map(row => ({
      ...JSON.parse(row.payload), type: row.kind === 'summary' ? 'summarize' : 'observation',
    })));
    const observations = sanitizeObservationFiles(parsed.observations, evidence).map(obs => ({
      ...obs, agent_id:input.agentId || null, agent_type:input.agentType || null,
    }));
    const summary = attachObservationFilesToSummary(normalizeSummaryForStorage(parsed.summary), [
      {files_read:evidence.files_read,files_modified:evidence.files_modified}, ...observations,
    ]);
    db.transaction(() => {
      const current = db.prepare('SELECT receipt FROM observer_queue_batches WHERE id=?').get(batch.id) as any;
      if (current.receipt) return;
      const saved = store.storeObservations(memoryId,context.project,observations,summary,
        input.prompt_number, (job.response.usage?.input_tokens || 0)+(job.response.usage?.output_tokens || 0),
        first.enqueued_at_epoch,job.response.model);
      this.manager.getObserverTaskStore().recordPersistedOutcome(rows.map(r=>r.id),JSON.stringify(saved));
      db.prepare("UPDATE observer_queue_batches SET state='succeeded',receipt=? WHERE id=?")
        .run(JSON.stringify({state:'completed',reference:'sqlite:observer_queue_batches:'+batch.id}),batch.id);
    })();
    this.manager.getCloudSync()?.notify();
  }

  async cycle(): Promise<void> {
    // Preparing several independent batches lets a single busy source session
    // fill gateway slots; this does not impose a model-execution concurrency limit.
    for (let i=0;i<8;i++) if (!this.prepareBatch()) break;
    const batches = this.manager.getConnection().prepare(`SELECT * FROM observer_queue_batches
      WHERE state IN ('pending','submitted') OR (state='reconciliation' AND error!='invalid_model_output') OR (receipt IS NOT NULL AND acknowledged=0) ORDER BY checked_at,created_at,id LIMIT 64`).all() as any[];
    // Short submit/status operations only. No long-lived SDK process or session.
    for (const batch of batches) {
      if (this.stopped) return;
      try { await this.processBatch(batch); }
      catch (error) { if (!this.stopped) logger.error('QUEUE','Observer batch remains durable',{batchId:batch.id},error as Error); }
      finally { this.manager.getConnection().prepare('UPDATE observer_queue_batches SET checked_at=? WHERE id=?').run(Date.now(),batch.id); }
    }
  }
  private async run(): Promise<void> {
    while (!this.stopped) {
      try { await this.cycle(); }
      catch (error) { if (!this.stopped) logger.error('QUEUE','Durable observer queue cycle failed',{},error as Error); }
      if (!this.stopped) await new Promise(resolve=>setTimeout(resolve,2000));
    }
  }
}
