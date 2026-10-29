/** Business batching/persistence only. The gateway owns all model execution limits. */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { parseEnv } from 'util';
import type { DatabaseManager } from './DatabaseManager.js';
import { buildObserverBatch, validateObserverProfile } from './ObserverBatchRequest.js';
import { parseAgentXml } from '../../sdk/parser.js';
import { ModeManager } from '../domain/ModeManager.js';
import { extractObservationFileEvidence, sanitizeObservationFiles, normalizeSummaryForStorage, attachObservationFilesToSummary } from './agents/ObservationNormalization.js';
import { gateObservationPersistence } from './agents/ObservationQualityGate.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { bodyGatewayDisposition, jobErrorDisposition, type GatewayDisposition } from './gateway-disposition.js';

export function gatewayQueueEnabled(): boolean { return !!process.env.CLAUDE_MEM_LLM_QUEUE_URL; }
export interface QueueConfig { url: string; tokenFile: string; tokenEnv?: boolean; maxItems: number; maxBytes: number;
  /** Submits per minute; the gateway maintainer's per-minute limit for claude_mem.observation. */
  submitsPerMinute?: number; }
/** credvault config/routes.nas.json claude_mem.observation limits.requests_per_minute (2026-10-19). */
export const DEFAULT_SUBMITS_PER_MINUTE = 60;
/** A paused route is probed this often (fleet-ops integration §6.3: kg-hub uses 300 s). */
export const PAUSE_PROBE_MS = 300_000;
/** retry without retry_after_seconds: 15 s doubling per consecutive refusal, capped. */
export const RETRY_BACKOFF_BASE_MS = 15_000;
export const MAX_HOLD_MS = 900_000;
/** A failed job that the gateway says may be retried gets this many new keys. */
export const MAX_REKEYS = 3;
/**
 * A submit refused with retry + same_key goes out again under the same key at
 * most this many times (§7.2); with the backoff above that is ~16 minutes of
 * refusals, or six retry_after_seconds waits.
 */
export const MAX_SAME_KEY_RETRIES = 6;
/** An unknown outcome is re-read on this interval, never re-sent. */
export const RECONCILIATION_RECHECK_MS = 60_000;

/** A non-2xx queue response with the gateway's own error body. */
export class GatewayQueueHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`observer_queue_http_${status}`);
    this.name = 'GatewayQueueHttpError';
  }
}

/** The route-wide hold the gateway asked for; persisted so a restart keeps it. */
export interface QueueHold { kind: 'paused' | 'retry'; code: string | null; message: string | null;
  batch_id: string | null; since: number; until: number; streak: number; }
export function readQueueHold(db: ReturnType<DatabaseManager['getConnection']>): QueueHold | null {
  return (db.prepare('SELECT kind,code,message,batch_id,since,until,streak FROM observer_queue_hold WHERE id=1').get() as QueueHold | null) ?? null;
}
export function queueConfig(): QueueConfig {
  const url = new URL(process.env.CLAUDE_MEM_LLM_QUEUE_URL!);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('observer_queue_requires_private_gateway_origin');
  }
  const rawFile = process.env.CLAUDE_MEM_LLM_QUEUE_TOKEN_FILE;
  const envFile = process.env.CLAUDE_MEM_LLM_QUEUE_TOKEN_ENV_FILE;
  if (rawFile && envFile) throw new Error('observer_queue_token_source_ambiguous');
  const tokenFile = rawFile || envFile;
  if (!tokenFile) throw new Error('observer_queue_token_file_required');
  const maxItems = Number(process.env.CLAUDE_MEM_LLM_BATCH_ITEMS || 20);
  const maxBytes = Number(process.env.CLAUDE_MEM_LLM_BATCH_BYTES || 64000);
  const submitsPerMinute = Number(process.env.CLAUDE_MEM_LLM_SUBMITS_PER_MINUTE || DEFAULT_SUBMITS_PER_MINUTE);
  validateObserverProfile({maxItems,maxBytes});
  if (!Number.isSafeInteger(submitsPerMinute) || submitsPerMinute < 1 || submitsPerMinute > 600) throw new Error('invalid_observer_submit_rate');
  return {url: url.origin, tokenFile, tokenEnv: !!envFile, maxItems, maxBytes, submitsPerMinute};
}

export function initializeQueueTables(db: ReturnType<DatabaseManager['getConnection']>): void {
  db.run(`CREATE TABLE IF NOT EXISTS observer_queue_inputs (
    task_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'observation', context TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS observer_queue_batches (
    id TEXT PRIMARY KEY, session_db_id INTEGER NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', result TEXT, receipt TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0)`);
  const columns = (db.prepare('PRAGMA table_info(observer_queue_batches)').all() as any[]).map(c=>c.name);
  for (const column of ['checked_at','next_check_at','attempt','retries']) if (!columns.includes(column)) {
    db.run(`ALTER TABLE observer_queue_batches ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  db.run(`CREATE TABLE IF NOT EXISTS observer_queue_hold (
    id INTEGER PRIMARY KEY CHECK (id=1), kind TEXT NOT NULL, code TEXT, message TEXT, batch_id TEXT,
    since INTEGER NOT NULL, until INTEGER NOT NULL, streak INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS observer_queue_members (
    task_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL)`);
  // Every batch row carries its request body (and later its result) ahead of the
  // state columns, so a scan that filters on state reads every body's overflow
  // pages: ~440 MB and ~3 s per scan at 17k batches (2026-10-22), synchronously
  // on the worker's event loop. The poll loop only ever looks at open batches and
  // unacknowledged receipts; these indexes keep it off the bodies.
  db.run('CREATE INDEX IF NOT EXISTS idx_observer_queue_batches_state ON observer_queue_batches(state, next_check_at)');
  db.run(`CREATE INDEX IF NOT EXISTS idx_observer_queue_batches_unacked ON observer_queue_batches(acknowledged)
    WHERE receipt IS NOT NULL`);
  db.run('CREATE INDEX IF NOT EXISTS idx_observer_queue_members_batch ON observer_queue_members(batch_id)');
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
  /** Submit times within the last minute; the throttle in front of the route limit (§7.3). */
  private submits: number[] = [];
  constructor(private manager: DatabaseManager, private config: QueueConfig,
              private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {
    initializeQueueTables(manager.getConnection());
  }
  start(): void { this.loop = this.run(); }
  async stop(): Promise<void> { this.stopped = true; this.abort.abort(); await this.loop; }

  private async request(path: string, body: object, key?: string): Promise<any> {
    const raw = readFileSync(this.config.tokenFile, 'utf8');
    const env = this.config.tokenEnv ? parseEnv(raw) : null;
    const token = env ? env.ANTHROPIC_AUTH_TOKEN : raw.trim();
    if (env && (!token || env.ANTHROPIC_API_KEY !== token)) throw new Error('managed_gateway_caller_mismatch');
    if (!token) throw new Error('empty_observer_gateway_token');
    const response = await this.fetcher(this.config.url+path, {
      method:'POST', redirect:'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,
               ...(key ? {'Idempotency-Key':key} : {})}, body:JSON.stringify(body),
    });
    if (!response.ok) {
      let body: unknown = null;
      try { body = await response.json(); } catch {}
      throw new GatewayQueueHttpError(response.status, body);
    }
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
      const first = candidates[0];
      const prior = first.kind === 'summary' ? db.prepare(`SELECT title,facts,narrative FROM observations
        WHERE memory_session_id=(SELECT memory_session_id FROM sdk_sessions WHERE id=?)
        ORDER BY created_at_epoch DESC,id DESC LIMIT 20`).all(first.session_db_id) : [];
      const {selected,body,overBudget} = buildObserverBatch(candidates,ModeManager.getInstance().getActiveMode(),this.config,prior);
      if (overBudget) {
        db.prepare("UPDATE observer_tasks SET state='failed',outcome='batch_input_over_budget',version=version+1 WHERE id=?").run(first.id);
        return true;
      }
      const raw = JSON.stringify(body);
      const id = 'cmq-'+createHash('sha256').update(JSON.stringify(selected.map(r=>r.id))).digest('hex');
      db.prepare('INSERT INTO observer_queue_batches(id,session_db_id,body,created_at) VALUES(?,?,?,?)')
        .run(id,first.session_db_id,raw,this.now());
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
      const receipt = JSON.parse(batch.receipt);
      // Name every field the gateway answered differently: a bare mismatch left
      // two batches failing ~100 acks each with no way to tell why (2026-10-22).
      const mismatched = ([
        ['request_key', batch.id, ack.job?.request_key],
        ['business_key', 'claude_mem.observation', ack.job?.business_key],
        ['business_receipt.state', receipt.state, ack.job?.business_receipt?.state],
        ['business_receipt.reference', receipt.reference, ack.job?.business_receipt?.reference],
      ] as const).filter(([, expected, got]) => expected !== got)
        .map(([field, expected, got]) => `${field} expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`);
      if (mismatched.length) {
        throw new Error(`observer_business_ack_identity_mismatch: ${mismatched.join('; ')} (gateway job state ${JSON.stringify(ack.job?.state)})`);
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
      // The gateway keeps a refused job queued and re-dispatches it under the
      // same key itself; the business only stops adding to the route.
      const refusal = job.state === 'queued' && job.error ? jobErrorDisposition(job.error) : null;
      if (refusal?.disposition === 'paused' || refusal?.disposition === 'retry') {
        const until = this.arm(refusal, batch.id);
        db.prepare('UPDATE observer_queue_batches SET state=?,error=?,next_check_at=? WHERE id=?')
          .run(refusal.disposition === 'paused' ? 'paused' : 'submitted',JSON.stringify(job.error),until,batch.id);
        return;
      }
      db.prepare("UPDATE observer_queue_batches SET state='submitted',error=NULL,next_check_at=0 WHERE id=?").run(batch.id);
      return;
    }
    if (job.state !== 'succeeded') {
      if (!['failed','reconciliation'].includes(job.state)) throw new Error('invalid_observer_queue_state');
      const outcome = job.state === 'failed' ? jobErrorDisposition(job.error) : null;
      if (outcome?.disposition === 'paused') {
        // credvault keeps a paused job queued and never ends one failed with
        // paused (execute_queued_request, 0253208); should it ever, a pause is
        // still a pause (§6.3②): no failure, no receipt, no new key, the same
        // key re-read on the long probe interval.
        const until = this.arm(outcome, batch.id);
        db.prepare("UPDATE observer_queue_batches SET state='paused',error=?,next_check_at=? WHERE id=?")
          .run(JSON.stringify(job.error),until,batch.id);
        return;
      }
      if (outcome?.disposition === 'retry' && (batch.attempt ?? 0) < MAX_REKEYS) {
        // A terminal job the gateway says may be retried: the old key already
        // has its terminal record, so the same request goes out under a new key.
        this.rekey(batch, job.error, outcome, true);
        return;
      }
      // Only reconciliation, or a failed job without a disposition, is unknown (§7.2).
      const failed = outcome?.disposition === 'failed' || outcome?.disposition === 'retry';
      db.transaction(() => {
        db.prepare('UPDATE observer_queue_batches SET state=?,error=?,next_check_at=? WHERE id=?')
          .run(failed ? 'failed' : 'reconciliation',JSON.stringify(job.error || {}),
               failed ? 0 : this.now()+RECONCILIATION_RECHECK_MS,batch.id);
        // The receipt is immutable: an unknown outcome gets none until it is settled.
        if (failed) db.prepare('UPDATE observer_queue_batches SET receipt=? WHERE id=?')
          .run(JSON.stringify({state:'failed',reference:'sqlite:observer_queue_batches:'+batch.id}),batch.id);
        for (const row of rows) db.prepare('UPDATE observer_tasks SET state=?,version=version+1 WHERE id=?')
          .run(failed ? 'failed' : 'reconciliation',row.id);
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
    const sourceMessages = rows.map(row => ({
      ...JSON.parse(row.payload), type: row.kind === 'summary' ? 'summarize' : 'observation',
    }));
    const evidence = extractObservationFileEvidence(sourceMessages);
    const quality = gateObservationPersistence(sanitizeObservationFiles(parsed.observations, evidence), sourceMessages);
    const observations = quality.observations.map(obs => ({
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
      this.manager.getObserverTaskStore().recordPersistedOutcome(rows.map(r=>r.id),JSON.stringify({
        ...saved,
        observationFiltering: { sourceIndices: quality.sourceIndices, rejected: quality.rejected },
      }));
      db.prepare("UPDATE observer_queue_batches SET state='succeeded',receipt=? WHERE id=?")
        .run(JSON.stringify({state:'completed',reference:'sqlite:observer_queue_batches:'+batch.id}),batch.id);
    })();
    this.manager.getCloudSync()?.notify();
  }

  /** Same request, new idempotency key; an old gateway job keeps its failed receipt. */
  private rekey(batch: any, error: unknown, outcome: GatewayDisposition, hasJob: boolean): void {
    const db = this.manager.getConnection(), attempt = (batch.attempt ?? 0)+1;
    const id = 'cmq-'+createHash('sha256').update(JSON.stringify({retry_of:batch.id,attempt})).digest('hex');
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO observer_queue_batches(id,session_db_id,body,created_at,attempt) VALUES(?,?,?,?,?)')
        .run(id,batch.session_db_id,batch.body,this.now(),attempt);
      db.prepare('UPDATE observer_queue_members SET batch_id=? WHERE batch_id=?').run(id,batch.id);
      db.prepare("UPDATE observer_queue_batches SET state='superseded',error=?,receipt=? WHERE id=?")
        .run(JSON.stringify(error || {}),
             hasJob ? JSON.stringify({state:'failed',reference:'sqlite:observer_queue_batches:'+batch.id}) : null,batch.id);
    })();
    this.arm(outcome, id);
  }

  hold(): QueueHold | null { return readQueueHold(this.manager.getConnection()); }
  private holdActive(): boolean { const hold = this.hold(); return !!hold && hold.until > this.now(); }
  private clearHold(): void { this.manager.getConnection().prepare('DELETE FROM observer_queue_hold WHERE id=1').run(); }

  /** Stop the route for the gateway's wait; returns when the batch is next looked at. */
  private arm(refusal: GatewayDisposition, batchId: string): number {
    const now = this.now(), prior = this.hold();
    // A pause outranks a backoff: a retry seen while paused does not shorten the probe interval.
    if (prior && prior.until > now && prior.kind === 'paused' && refusal.disposition === 'retry') return prior.until;
    const kind = refusal.disposition === 'paused' ? 'paused' : 'retry';
    const streak = prior?.kind === kind ? prior.streak+1 : 0;
    const wait = refusal.retryAfterMs ?? (kind === 'paused' ? PAUSE_PROBE_MS : RETRY_BACKOFF_BASE_MS*2**Math.min(streak,6));
    const until = now+Math.min(Math.max(wait,1000),MAX_HOLD_MS);
    this.manager.getConnection().prepare(`INSERT OR REPLACE INTO observer_queue_hold(id,kind,code,message,batch_id,since,until,streak)
      VALUES(1,?,?,?,?,?,?,?)`).run(kind,refusal.code ?? null,refusal.message ?? null,batchId,
        prior?.kind === kind ? prior.since : now,until,streak);
    if (prior?.kind !== kind) logger.warn('QUEUE', kind === 'paused'
      ? 'Model gateway paused this route; new batches stop until a probe sees it back'
      : 'Model gateway deferred this route; backing off before the next submit',
      {code:refusal.code,until:new Date(until).toISOString(),batchId});
    return until;
  }

  /** The route throttle (§7.3): never more submits per minute than the route allows. */
  private takeSubmitSlot(): boolean {
    const now = this.now();
    this.submits = this.submits.filter(t => t > now-60_000);
    if (this.submits.length >= (this.config.submitsPerMinute ?? DEFAULT_SUBMITS_PER_MINUTE)) return false;
    this.submits.push(now);
    return true;
  }

  /** A queue call refused with the gateway's error body (not a job outcome). */
  private refused(batch: any, error: unknown): void {
    if (!(error instanceof GatewayQueueHttpError) || batch.receipt) return;
    const refusal = bodyGatewayDisposition(error.body);
    if (refusal?.disposition === 'paused') this.arm(refusal, batch.id);
    else if (refusal?.disposition === 'retry') {
      // A refused status read re-sends nothing; only a refused submit is bounded.
      if (batch.state !== 'pending') this.arm(refusal, batch.id);
      else if (refusal.sameKey ? (batch.retries ?? 0) < MAX_SAME_KEY_RETRIES : (batch.attempt ?? 0) < MAX_REKEYS) {
        if (!refusal.sameKey) this.rekey(batch, error.body, refusal, false);
        else {
          this.manager.getConnection().prepare('UPDATE observer_queue_batches SET retries=retries+1 WHERE id=?').run(batch.id);
          this.arm(refusal, batch.id);
        }
      } else {
        // Retries spent: a temporary failure, never reconciliation (§7.2). The
        // route still waits out the refusal before the next batch goes.
        this.arm(refusal, batch.id);
        this.failUnsubmitted(batch, error.body, 'gateway_retry_exhausted');
      }
    } else if (refusal?.disposition === 'failed' && batch.state === 'pending') this.failUnsubmitted(batch, error.body, null);
  }

  /** Refused at submit: no job exists, so there is no receipt to give. */
  private failUnsubmitted(batch: any, body: unknown, outcome: string | null): void {
    const db = this.manager.getConnection();
    db.transaction(() => {
      db.prepare("UPDATE observer_queue_batches SET state='failed',error=? WHERE id=?").run(JSON.stringify(body),batch.id);
      for (const row of this.members(batch.id)) db.prepare("UPDATE observer_tasks SET state='failed',outcome=COALESCE(?,outcome),version=version+1 WHERE id=?")
        .run(outcome,row.id);
    })();
  }

  /** True when the gateway answered (a job state, or a refusal with a disposition). */
  private async attempt(batch: any): Promise<boolean> {
    try { await this.processBatch(batch); return true; }
    catch (error) {
      if (this.stopped) return false;
      this.refused(batch, error);
      logger.error('QUEUE','Observer batch remains durable',{batchId:batch.id},error as Error);
      return error instanceof GatewayQueueHttpError && !!bodyGatewayDisposition(error.body);
    }
    finally { this.manager.getConnection().prepare('UPDATE observer_queue_batches SET checked_at=? WHERE id=?').run(this.now(),batch.id); }
  }

  /**
   * While the gateway holds the route nothing is batched or submitted. When the
   * wait is over, one probe (the batch that met the refusal) goes first; the
   * route reopens only if the gateway no longer refuses it.
   */
  private async probe(): Promise<boolean> {
    const hold = this.hold();
    if (!hold) return false;
    if (hold.until > this.now()) return true;
    const db = this.manager.getConnection();
    const batch = db.prepare(`SELECT * FROM observer_queue_batches WHERE id=? AND receipt IS NULL
      AND state IN ('pending','submitted','paused')`).get(hold.batch_id) as any;
    if (batch) {
      if (batch.state === 'pending') this.takeSubmitSlot();
      const answered = await this.attempt(batch);
      if (this.holdActive()) return true;
      if (!answered) {
        // No answer from the gateway (network, relay): wait another interval.
        db.prepare('UPDATE observer_queue_hold SET until=? WHERE id=1')
          .run(this.now()+(hold.kind === 'paused' ? PAUSE_PROBE_MS : RETRY_BACKOFF_BASE_MS));
        return true;
      }
    }
    this.clearHold();
    return false;
  }

  async cycle(): Promise<void> {
    const db = this.manager.getConnection();
    if (await this.probe()) {
      // Business receipts are not model calls; they still drain while held.
      for (const batch of db.prepare(`SELECT * FROM observer_queue_batches WHERE receipt IS NOT NULL
        AND acknowledged=0 ORDER BY checked_at,created_at,id LIMIT 64`).all() as any[]) {
        if (this.stopped) return;
        await this.attempt(batch);
      }
      return;
    }
    // Preparing several independent batches lets a single busy source session
    // fill gateway slots; this does not impose a model-execution concurrency limit.
    // At most 8 prepared batches wait for a submit slot.
    let waiting = (db.prepare("SELECT count(*) AS n FROM observer_queue_batches WHERE state='pending' AND receipt IS NULL").get() as any).n;
    for (let i=0;i<8 && waiting<8;i++) { if (!this.prepareBatch()) break; waiting++; }
    // Each branch is answered from its own index; only the selected rows are read.
    const batches = db.prepare(`SELECT * FROM observer_queue_batches WHERE id IN (
        SELECT id FROM observer_queue_batches WHERE state IN ('pending','submitted','paused','reconciliation')
          AND next_check_at<=? AND (state!='reconciliation' OR error!='invalid_model_output')
        UNION SELECT id FROM observer_queue_batches WHERE receipt IS NOT NULL AND acknowledged=0)
      ORDER BY checked_at,created_at,id LIMIT 64`).all(this.now()) as any[];
    // Short submit/status operations only. No long-lived SDK process or session.
    for (const batch of batches) {
      if (this.stopped) return;
      const submits = batch.state === 'pending' && !batch.receipt;
      // A refusal met earlier in this cycle stops every further submit and
      // status read; receipts still go through.
      if (!batch.receipt && this.holdActive()) continue;
      if (submits && !this.takeSubmitSlot()) continue;
      await this.attempt(batch);
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
