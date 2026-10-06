import { initializeQueueTables, ownQueueInput } from './GatewayObserverQueue.js';
import { createHash, randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export type ObserverTaskState = 'queued' | 'running' | 'reconciliation' | 'retry_authorized' | 'succeeded' | 'skipped' | 'failed';

export interface ObserverTaskInput {
  sessionDbId: number;
  contentSessionId: string;
  sourceId: string | null;
  payload: string;
  enqueuedAtEpoch?: number;
  queueContext?: { project: string; userPrompt: string };
  queueKind?: string;
}

export interface ObserverTaskRow extends Omit<ObserverTaskInput, 'enqueuedAtEpoch'> {
  id: string;
  state: ObserverTaskState;
  actualCalls: number;
  version: number;
  outcome: string | null;
  enqueuedAtEpoch: number | null;
}

export interface PreparedObserverPrompt {
  taskId: string;
  prompt: string;
  promptDigest: string;
  enqueuedAtEpoch: number;
}

export interface RetryDecision {
  commandId: string;
  taskId: string;
  modelStepId: string;
  expectedVersion: number;
  verifiedStepCalls: number;
  /** True only after an authoritative gateway query proves no call remains in flight. */
  noInFlight: boolean;
}

export type RetryReservation =
  | { accepted: true; version: number; duplicate: boolean }
  | { accepted: false; reason: 'not_found' | 'version_conflict' | 'not_reconciling' | 'uncertain_calls' | 'exhausted' | 'in_flight' };

/** Durable source and state for observer work. The RAM message id is never an identity. */
export class ObserverTaskStore {
  constructor(private readonly db: Database) {
    initializeQueueTables(db);
    db.run(`CREATE TABLE IF NOT EXISTS observer_tasks (
      id TEXT PRIMARY KEY,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      source_id TEXT,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      actual_calls INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      outcome TEXT,
      enqueued_at_epoch INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_db_id, source_id)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_observer_tasks_state ON observer_tasks(state, session_db_id)');
    const columns = db.prepare('PRAGMA table_info(observer_tasks)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'version')) {
      db.run('ALTER TABLE observer_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    }
    if (!columns.some(column => column.name === 'enqueued_at_epoch')) {
      db.run('ALTER TABLE observer_tasks ADD COLUMN enqueued_at_epoch INTEGER');
    }
    db.run(`CREATE TABLE IF NOT EXISTS observer_task_prepared_prompts (
      task_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      prompt_digest TEXT NOT NULL,
      enqueued_at_epoch INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS observer_task_commands (
      command_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      model_step_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('check', 'retry')),
      state TEXT NOT NULL CHECK(state IN ('accepted', 'started', 'finished')),
      result_state TEXT,
      result_version INTEGER,
      result_reason TEXT,
      baseline_actual_calls INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const commandColumns = db.prepare('PRAGMA table_info(observer_task_commands)').all() as Array<{ name: string }>;
    for (const [name, declaration] of [
      ['result_state', 'TEXT'], ['result_version', 'INTEGER'], ['result_reason', 'TEXT'],
      ['permit_id', 'TEXT'], ['idempotency_key', 'TEXT'], ['prompt_digest', 'TEXT'],
      ['baseline_actual_calls', 'INTEGER'],
    ] as const) {
      if (!commandColumns.some(column => column.name === name)) {
        db.run(`ALTER TABLE observer_task_commands ADD COLUMN ${name} ${declaration}`);
      }
    }
    db.run(`CREATE TABLE IF NOT EXISTS observer_task_steps (
      task_id TEXT NOT NULL,
      model_step_id TEXT NOT NULL,
      actual_calls INTEGER NOT NULL DEFAULT 0 CHECK(actual_calls BETWEEN 0 AND 3),
      state TEXT NOT NULL DEFAULT 'reconciliation' CHECK(state IN ('reconciliation', 'succeeded', 'failed')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(task_id, model_step_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS observer_task_attempt_failures (
      task_id TEXT NOT NULL,
      model_step_id TEXT NOT NULL,
      gateway_identity TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(task_id, model_step_id, gateway_identity)
    )`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_observer_failure_identity
      ON observer_task_attempt_failures(task_id, gateway_identity)`);
  }

  create(input: ObserverTaskInput): string {
    return this.db.transaction(() => this.createSource(input))();
  }

  private createSource(input: ObserverTaskInput): string {
    const id = randomUUID();
    const epoch = input.enqueuedAtEpoch ?? Date.now();
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('invalid_observer_enqueue_time');
    const inserted = this.db.prepare(`INSERT INTO observer_tasks
      (id, session_db_id, content_session_id, source_id, payload, enqueued_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_db_id, source_id) DO NOTHING`)
      .run(id, input.sessionDbId, input.contentSessionId, input.sourceId, input.payload, epoch);
    if (inserted.changes && input.queueContext) {
      ownQueueInput(this.db, id, input.queueContext, input.queueKind);
    }
    if (input.sourceId) {
      const row = this.db.prepare('SELECT id, payload FROM observer_tasks WHERE session_db_id = ? AND source_id = ?')
        .get(input.sessionDbId, input.sourceId) as { id: string; payload: string };
      if (row.payload !== input.payload) {
        logger.warn('WORKER', 'Observer task source identity conflicts with persisted payload', {
          sessionDbId: input.sessionDbId,
        });
        throw new Error('observer_task_source_payload_changed');
      }
      logger.debug('QUEUE', 'Observer task persisted', {
        taskId: row.id,
        sessionDbId: input.sessionDbId,
        reusedExisting: row.id !== id,
      });
      return row.id;
    }
    logger.debug('QUEUE', 'Observer task persisted', { taskId: id, sessionDbId: input.sessionDbId });
    return id;
  }

  get(id: string): ObserverTaskRow | null {
    const row = this.db.prepare(`SELECT id, session_db_id AS sessionDbId,
      content_session_id AS contentSessionId, source_id AS sourceId, payload,
      state, actual_calls AS actualCalls, version, outcome,
      enqueued_at_epoch AS enqueuedAtEpoch FROM observer_tasks WHERE id = ?`)
      .get(id) as ObserverTaskRow | undefined;
    return row ?? null;
  }

  markRecoveryUnavailable(taskId: string, reason: string): void {
    this.db.prepare(`UPDATE observer_tasks SET state = 'failed', outcome = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state = 'reconciliation'`).run(reason, taskId);
  }

  /** Save the exact prompt before handing it to the SDK for its first send. */
  recordPreparedPrompt(taskId: string, prompt: string, enqueuedAtEpoch: number): PreparedObserverPrompt {
    if (!prompt || !Number.isSafeInteger(enqueuedAtEpoch) || enqueuedAtEpoch <= 0) {
      throw new Error('invalid_prepared_observer_prompt');
    }
    const promptDigest = createHash('sha256').update(prompt).digest('hex');
    return this.db.transaction(() => {
      const task = this.get(taskId);
      if (!task || task.enqueuedAtEpoch !== enqueuedAtEpoch) {
        throw new Error('observer_task_enqueue_time_changed');
      }
      const existing = this.getPreparedPrompt(taskId);
      if (existing) {
        if (existing.prompt !== prompt || existing.promptDigest !== promptDigest ||
            existing.enqueuedAtEpoch !== enqueuedAtEpoch) {
          throw new Error('observer_task_prepared_prompt_changed');
        }
        return existing;
      }
      this.db.prepare(`INSERT INTO observer_task_prepared_prompts
        (task_id, prompt, prompt_digest, enqueued_at_epoch) VALUES (?, ?, ?, ?)`)
        .run(taskId, prompt, promptDigest, enqueuedAtEpoch);
      return { taskId, prompt, promptDigest, enqueuedAtEpoch };
    })();
  }

  getPreparedPrompt(taskId: string): PreparedObserverPrompt | null {
    const row = this.db.prepare(`SELECT task_id AS taskId, prompt,
      prompt_digest AS promptDigest, enqueued_at_epoch AS enqueuedAtEpoch
      FROM observer_task_prepared_prompts WHERE task_id = ?`)
      .get(taskId) as PreparedObserverPrompt | undefined;
    return row ?? null;
  }

  /** Read the exact permit installed for a durable manual replay command. */
  getManualReplayAdmission(commandId: string, taskId: string): {
    commandId: string; taskId: string; modelStepId: string; permitId: string;
    idempotencyKey: string; promptDigest: string; baselineActualCalls: number;
  } | null {
    const row = this.db.prepare(`SELECT command_id AS commandId, task_id AS taskId,
      model_step_id AS modelStepId, permit_id AS permitId,
      idempotency_key AS idempotencyKey, prompt_digest AS promptDigest,
      baseline_actual_calls AS baselineActualCalls
      FROM observer_task_commands WHERE command_id = ? AND task_id = ?
      AND action = 'retry' AND state = 'started'`)
      .get(commandId, taskId) as {
        commandId: string; taskId: string; modelStepId: string | null; permitId: string | null;
        idempotencyKey: string | null; promptDigest: string | null; baselineActualCalls: number | null;
      } | undefined;
    if (!row?.modelStepId || !row.permitId || !row.idempotencyKey || !row.promptDigest ||
        row.baselineActualCalls === null) return null;
    return { ...row, modelStepId: row.modelStepId, permitId: row.permitId,
      idempotencyKey: row.idempotencyKey, promptDigest: row.promptDigest,
      baselineActualCalls: row.baselineActualCalls };
  }

  needsReconciliation(ids: string[]): void {
    const update = this.db.prepare(`UPDATE observer_tasks SET state = 'reconciliation',
      version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state IN ('queued', 'running')`);
    this.db.transaction(() => { for (const id of ids) update.run(id); })();
  }

  recordPersistedOutcome(ids: string[], outcome: string): void {
    const update = this.db.prepare(`UPDATE observer_tasks SET state = 'succeeded', outcome = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state IN ('queued', 'running', 'reconciliation')`);
    this.db.transaction(() => { for (const id of ids) update.run(outcome, id); })();
  }

  recordSkipped(ids: string[], reason: string): void {
    const update = this.db.prepare(`UPDATE observer_tasks SET state = 'skipped', outcome = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state IN ('queued', 'running')`);
    this.db.transaction(() => { for (const id of ids) update.run(reason, id); })();
  }

  /** On restart, no in-RAM claim can prove whether an old queued row was sent. */
  markStrandedQueuedForReconciliation(): number {
    const result = this.db.prepare(`UPDATE observer_tasks SET state = 'reconciliation',
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE state IN ('queued', 'running', 'retry_authorized')
      AND id NOT IN (SELECT task_id FROM observer_queue_inputs)`).run();
    return result.changes;
  }

  /** Atomically queue one permit-backed human replay and persist its identity. */
  queueManualReplay(input: {
    commandId: string;
    taskId: string;
    modelStepId: string;
    observedVersion: number;
    permitId: string;
    idempotencyKey: string;
    promptDigest: string;
    baselineActualCalls: number;
  }): { queued: boolean; version: number; reason: 'queued' | 'already_started' | 'task_changed' | 'call_budget_exhausted' | 'prompt_changed' } {
    if (!/^[a-f0-9-]{36}$/i.test(input.commandId) || !/^[a-f0-9-]{36}$/i.test(input.taskId) ||
        !/^[a-f0-9]{64}$/.test(input.modelStepId) || !/^[a-f0-9-]{36}$/i.test(input.permitId) ||
        input.permitId !== input.commandId ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey) ||
        !/^[a-f0-9]{64}$/.test(input.promptDigest) || !Number.isSafeInteger(input.observedVersion) ||
        !Number.isSafeInteger(input.baselineActualCalls) || input.baselineActualCalls < 0) {
      throw new Error('invalid_manual_replay_admission');
    }
    const queue = this.db.transaction((): {
      queued: boolean; version: number;
      reason: 'queued' | 'already_started' | 'task_changed' | 'call_budget_exhausted' | 'prompt_changed';
    } => {
      const command = this.db.prepare(`SELECT task_id AS taskId,
        model_step_id AS modelStepId, action, state, permit_id AS permitId,
        idempotency_key AS idempotencyKey, prompt_digest AS promptDigest,
        baseline_actual_calls AS baselineActualCalls
        FROM observer_task_commands WHERE command_id = ?`)
        .get(input.commandId) as {
          taskId: string; modelStepId: string; action: string; state: string;
          permitId: string | null; idempotencyKey: string | null; promptDigest: string | null;
          baselineActualCalls: number | null;
        } | undefined;
      if (!command || command.taskId !== input.taskId || command.modelStepId !== input.modelStepId ||
          command.action !== 'retry') throw new Error('manual_replay_command_identity_conflict');
      if (command.state !== 'accepted') {
        const current = this.get(input.taskId);
        return { queued: false, version: current?.version ?? input.observedVersion, reason: 'already_started' };
      }
      if (command.permitId && (command.permitId !== input.permitId ||
          command.idempotencyKey !== input.idempotencyKey || command.promptDigest !== input.promptDigest)) {
        throw new Error('manual_replay_permit_identity_conflict');
      }

      const task = this.get(input.taskId);
      if (!task) throw new Error('observer_task_not_found');
      if (task.state !== 'reconciliation' || task.version !== input.observedVersion) {
        return { queued: false, version: task.version, reason: 'task_changed' };
      }
      if (task.actualCalls >= 3 || this.getTaskBusinessFailureCount(input.taskId) >= 3) {
        return { queued: false, version: task.version, reason: 'call_budget_exhausted' };
      }
      if (input.idempotencyKey !== `cmretry-${input.commandId}`) {
        throw new Error('manual_replay_idempotency_key_conflict');
      }
      if (command.permitId && command.baselineActualCalls !== input.baselineActualCalls) {
        throw new Error('manual_replay_call_baseline_conflict');
      }
      const prepared = this.getPreparedPrompt(input.taskId);
      if (!prepared || prepared.promptDigest !== input.promptDigest) {
        return { queued: false, version: task.version, reason: 'prompt_changed' };
      }

      const changed = this.db.prepare(`UPDATE observer_tasks SET state = 'queued',
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'reconciliation' AND version = ? AND actual_calls < 3`)
        .run(input.taskId, input.observedVersion);
      if (changed.changes !== 1) {
        const current = this.get(input.taskId);
        return { queued: false, version: current?.version ?? input.observedVersion, reason: 'task_changed' };
      }
      this.db.prepare(`UPDATE observer_task_commands SET state = 'started', permit_id = ?,
        idempotency_key = ?, prompt_digest = ?, baseline_actual_calls = ?, updated_at = CURRENT_TIMESTAMP
        WHERE command_id = ? AND state = 'accepted'`)
        .run(input.permitId, input.idempotencyKey, input.promptDigest, input.baselineActualCalls, input.commandId);
      return { queued: true, version: input.observedVersion + 1, reason: 'queued' };
    });
    return queue();
  }

  markManualReplayRunning(taskId: string): number | null {
    const changed = this.db.prepare(`UPDATE observer_tasks SET state = 'running',
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state = 'queued'`).run(taskId);
    return changed.changes === 1 ? this.get(taskId)?.version ?? null : null;
  }

  cancelManualReplayBeforeStart(taskId: string, commandId: string): number | null {
    return this.db.transaction(() => {
      const command = this.db.prepare(`SELECT 1 FROM observer_task_commands
        WHERE command_id = ? AND task_id = ? AND action = 'retry' AND state = 'started'`)
        .get(commandId, taskId);
      if (!command) return null;
      const changed = this.db.prepare(`UPDATE observer_tasks SET state = 'reconciliation',
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'queued'`).run(taskId);
      return changed.changes === 1 ? this.get(taskId)?.version ?? null : null;
    })();
  }

  /** Persist an authoritative gateway witness for one stable business step. */
  recordStepWitness(taskId: string, modelStepId: string, actualCalls: number): void {
    if (!modelStepId || !Number.isInteger(actualCalls) || actualCalls < 0) {
      throw new Error('invalid_model_step_witness');
    }
    this.db.transaction(() => {
      if (!this.get(taskId)) throw new Error('observer_task_not_found');
      const row = this.db.prepare(`SELECT actual_calls AS actualCalls, state
        FROM observer_task_steps WHERE task_id = ? AND model_step_id = ?`)
        .get(taskId, modelStepId) as { actualCalls: number; state: string } | undefined;
      if (row && actualCalls < row.actualCalls) throw new Error('model_step_call_count_regressed');
      if (actualCalls > 3) {
        this.db.prepare(`INSERT INTO observer_task_steps
          (task_id, model_step_id, actual_calls, state) VALUES (?, ?, 3, 'failed')
          ON CONFLICT(task_id, model_step_id) DO UPDATE SET
          actual_calls = 3, state = 'failed', updated_at = CURRENT_TIMESTAMP`)
          .run(taskId, modelStepId);
        this.db.prepare(`UPDATE observer_tasks SET state = 'failed', outcome = 'actual_call_limit_exceeded',
          version = version + 1, actual_calls = 3, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND state = 'reconciliation'`).run(taskId);
        return;
      }
      // A transport-start witness consumes the call budget, but is not itself
      // proof that the model call failed. Only `recordExpiredBusinessAttempt`
      // (three independently witnessed failed HTTP attempts) may terminalize
      // an otherwise unresolved task.
      const state = row?.state === 'succeeded' ? 'succeeded' : 'reconciliation';
      this.db.prepare(`INSERT INTO observer_task_steps
        (task_id, model_step_id, actual_calls, state) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id, model_step_id) DO UPDATE SET
        actual_calls = excluded.actual_calls, state = excluded.state,
        updated_at = CURRENT_TIMESTAMP`).run(taskId, modelStepId, actualCalls, state);
      const aggregate = this.db.prepare(`SELECT COALESCE(SUM(actual_calls), 0) AS calls
        FROM observer_task_steps WHERE task_id = ?`).get(taskId) as { calls: number };
      this.applyVerifiedCallCount(taskId, aggregate.calls);
    })();
  }

  /** Store the gateway's witnessed model-call count. Unknown evidence never enters here. */
  applyVerifiedCallCount(taskId: string, actualCalls: number): ObserverTaskRow | null {
    if (!Number.isInteger(actualCalls) || actualCalls < 0) throw new Error('invalid_actual_call_count');
    if (actualCalls > 3) {
      this.db.prepare(`UPDATE observer_tasks SET actual_calls = 3, state = 'failed',
        outcome = 'actual_call_limit_exceeded', version = version + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'reconciliation'`).run(taskId);
      return this.get(taskId);
    }
    this.db.prepare(`UPDATE observer_tasks SET actual_calls = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state IN ('queued', 'running', 'reconciliation', 'failed') AND actual_calls != ?`)
      .run(actualCalls, taskId, actualCalls);
    return this.get(taskId);
  }

  reserveManualRetry(input: RetryDecision): RetryReservation {
    return this.db.transaction((): RetryReservation => {
      const prior = this.db.prepare('SELECT task_id AS taskId, model_step_id AS modelStepId, action, state FROM observer_task_commands WHERE command_id = ?')
        .get(input.commandId) as { taskId: string; modelStepId: string; action: string; state: string } | undefined;
      if (prior) {
        if (prior.taskId !== input.taskId || prior.modelStepId !== input.modelStepId || prior.action !== 'retry') {
          return { accepted: false, reason: 'version_conflict' };
        }
        const task = this.get(input.taskId);
        return task ? { accepted: true, version: task.version, duplicate: true } : { accepted: false, reason: 'not_found' };
      }
      const task = this.get(input.taskId);
      if (!task) return { accepted: false, reason: 'not_found' };
      if (task.version !== input.expectedVersion) return { accepted: false, reason: 'version_conflict' };
      if (task.state !== 'reconciliation') return { accepted: false, reason: 'not_reconciling' };
      if (!input.modelStepId || !Number.isInteger(input.verifiedStepCalls) || input.verifiedStepCalls < 0) {
        return { accepted: false, reason: 'uncertain_calls' };
      }
      const step = this.db.prepare(`SELECT actual_calls AS actualCalls, state
        FROM observer_task_steps WHERE task_id = ? AND model_step_id = ?`)
        .get(input.taskId, input.modelStepId) as { actualCalls: number; state: string } | undefined;
      if (!step || step.actualCalls !== input.verifiedStepCalls || step.state !== 'reconciliation') {
        return { accepted: false, reason: 'uncertain_calls' };
      }
      if (!input.noInFlight) return { accepted: false, reason: 'in_flight' };
      if (input.verifiedStepCalls >= 3) return { accepted: false, reason: 'exhausted' };
      // Preserve the global task ceiling as well as the per-step ceiling.
      // A model SDK may issue several distinct internal calls for one task.
      if (task.actualCalls >= 3) return { accepted: false, reason: 'exhausted' };
      this.db.prepare(`UPDATE observer_tasks SET state = 'retry_authorized',
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'reconciliation' AND version = ?`)
        .run(input.taskId, input.expectedVersion);
      this.db.prepare(`INSERT INTO observer_task_commands (command_id, task_id, model_step_id, action, state)
        VALUES (?, ?, ?, 'retry', 'accepted')`).run(input.commandId, input.taskId, input.modelStepId);
      return { accepted: true, version: input.expectedVersion + 1, duplicate: false };
    })();
  }

  startManualRetry(commandId: string, taskId: string): boolean {
    return this.db.transaction(() => {
      const command = this.db.prepare(`UPDATE observer_task_commands SET state = 'started',
        updated_at = CURRENT_TIMESTAMP WHERE command_id = ? AND task_id = ?
        AND action = 'retry' AND state = 'accepted'`).run(commandId, taskId);
      if (command.changes !== 1) return false;
      const task = this.db.prepare(`UPDATE observer_tasks SET state = 'queued',
        version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'retry_authorized'`).run(taskId);
      if (task.changes !== 1) throw new Error('manual_retry_task_state_changed');
      return true;
    })();
  }

  /** Claim a mailbox command locally. Re-delivery returns its saved result. */
  beginCheckCommand(commandId: string, taskId: string, modelStepId: string):
    { duplicate: boolean; finished: boolean; resultState: string | null; resultVersion: number | null; resultReason: string | null } {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT task_id AS taskId, model_step_id AS modelStepId,
        action, state, result_state AS resultState, result_version AS resultVersion,
        result_reason AS resultReason FROM observer_task_commands WHERE command_id = ?`)
        .get(commandId) as {
          taskId: string; modelStepId: string; action: string; state: string;
          resultState: string | null; resultVersion: number | null; resultReason: string | null;
        } | undefined;
      if (row) {
        if (row.taskId !== taskId || row.modelStepId !== modelStepId || row.action !== 'check') {
          throw new Error('observer_command_identity_conflict');
        }
        return { duplicate: true, finished: row.state === 'finished',
          resultState: row.resultState, resultVersion: row.resultVersion, resultReason: row.resultReason };
      }
      this.db.prepare(`INSERT INTO observer_task_commands
        (command_id, task_id, model_step_id, action, state) VALUES (?, ?, ?, 'check', 'accepted')`)
        .run(commandId, taskId, modelStepId);
      return { duplicate: false, finished: false, resultState: null, resultVersion: null, resultReason: null };
    })();
  }

  finishCheckCommand(commandId: string, taskId: string, resultState: string,
    resultVersion: number, resultReason: string): void {
    const result = this.db.prepare(`UPDATE observer_task_commands SET state = 'finished',
      result_state = ?, result_version = ?, result_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE command_id = ? AND task_id = ? AND action = 'check' AND state = 'accepted'`)
      .run(resultState, resultVersion, resultReason, commandId, taskId);
    if (result.changes !== 1) throw new Error('observer_check_command_not_claimed');
  }

  /** Claim an explicit operator retry intent; this does not enqueue model work. */
  beginRetryCommand(commandId: string, taskId: string, modelStepId: string):
    { duplicate: boolean; finished: boolean; resultState: string | null; resultVersion: number | null; resultReason: string | null } {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT task_id AS taskId, model_step_id AS modelStepId,
        action, state, result_state AS resultState, result_version AS resultVersion,
        result_reason AS resultReason FROM observer_task_commands WHERE command_id = ?`)
        .get(commandId) as {
          taskId: string; modelStepId: string; action: string; state: string;
          resultState: string | null; resultVersion: number | null; resultReason: string | null;
        } | undefined;
      if (row) {
        if (row.taskId !== taskId || row.modelStepId !== modelStepId || row.action !== 'retry') {
          throw new Error('observer_command_identity_conflict');
        }
        return { duplicate: true, finished: row.state === 'finished',
          resultState: row.resultState, resultVersion: row.resultVersion, resultReason: row.resultReason };
      }
      this.db.prepare(`INSERT INTO observer_task_commands
        (command_id, task_id, model_step_id, action, state) VALUES (?, ?, ?, 'retry', 'accepted')`)
        .run(commandId, taskId, modelStepId);
      return { duplicate: false, finished: false, resultState: null, resultVersion: null, resultReason: null };
    })();
  }

  finishRetryCommand(commandId: string, taskId: string, resultState: string,
    resultVersion: number, resultReason: string): void {
    const result = this.db.prepare(`UPDATE observer_task_commands SET state = 'finished',
      result_state = ?, result_version = ?, result_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE command_id = ? AND task_id = ? AND action = 'retry' AND state IN ('accepted', 'started')`)
      .run(resultState, resultVersion, resultReason, commandId, taskId);
    if (result.changes !== 1) throw new Error('observer_retry_command_not_claimed');
  }

  /** Ensure a completed human reconciliation can be reported above its input version. */
  advanceVersionForCommand(taskId: string, expectedVersion: number): number {
    const row = this.get(taskId);
    if (!row) throw new Error('observer_task_not_found');
    if (row.version > expectedVersion) return row.version;
    if (row.version < expectedVersion) throw new Error('observer_task_version_ahead_of_store');
    const result = this.db.prepare(`UPDATE observer_tasks SET version = version + 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?`)
      .run(taskId, expectedVersion);
    if (result.changes !== 1) throw new Error('observer_task_version_changed');
    return expectedVersion + 1;
  }

  getCommandResult(commandId: string):
    { state: string; version: number; reason: string } | null {
    const row = this.db.prepare(`SELECT result_state AS state, result_version AS version,
      result_reason AS reason FROM observer_task_commands
      WHERE command_id = ? AND state = 'finished'`).get(commandId) as
      { state: string | null; version: number | null; reason: string | null } | undefined;
    if (!row || row.state === null || row.version === null || row.reason === null) return null;
    return { state: row.state, version: row.version, reason: row.reason };
  }

  /** A timed-out admitted request is a failed business attempt, independent of billing. */
  recordExpiredBusinessAttempt(taskId: string, modelStepId: string, gatewayIdentity: string): number {
    return this.recordFailedBusinessAttempt(taskId, modelStepId, gatewayIdentity,
      'deadline_expired_without_business_result');
  }

  recordFailedBusinessAttempt(taskId: string, modelStepId: string, gatewayIdentity: string,
    reason: 'deadline_expired_without_business_result' | 'gateway_response_without_business_receipt' |
      'provider_failed_without_business_result'): number {
    if (!/^[a-f0-9]{64}$/.test(modelStepId) || !/^[a-f0-9]{64}$/.test(gatewayIdentity)) {
      throw new Error('invalid_gateway_attempt_identity');
    }
    return this.db.transaction(() => {
      const task = this.get(taskId);
      if (!task) throw new Error('observer_task_not_found');
      if (!['queued', 'running', 'reconciliation'].includes(task.state)) {
        return this.getBusinessFailureCount(taskId, modelStepId);
      }
      const identityOwner = this.db.prepare(`SELECT model_step_id AS modelStepId
        FROM observer_task_attempt_failures WHERE task_id = ? AND gateway_identity = ?`)
        .get(taskId, gatewayIdentity) as { modelStepId: string } | undefined;
      if (identityOwner && identityOwner.modelStepId !== modelStepId) {
        throw new Error('observer_gateway_identity_step_conflict');
      }
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO observer_task_attempt_failures
        (task_id, model_step_id, gateway_identity, reason) VALUES (?, ?, ?, ?)`)
        .run(taskId, modelStepId, gatewayIdentity, reason).changes;
      const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM observer_task_attempt_failures
        WHERE task_id = ? AND model_step_id = ?`).get(taskId, modelStepId) as { count: number }).count;
      const taskFailureCount = this.getTaskBusinessFailureCount(taskId);
      if (inserted) {
        this.db.prepare(`UPDATE observer_tasks SET version = version + 1,
          state = CASE WHEN ? >= 3 THEN 'failed' ELSE 'reconciliation' END,
          outcome = CASE WHEN ? >= 3 THEN 'three_failed_business_attempts' ELSE outcome END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state IN ('queued', 'running', 'reconciliation')`)
          .run(taskFailureCount, taskFailureCount, taskId);
      }
      return count;
    })();
  }

  getBusinessFailureCount(taskId: string, modelStepId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM observer_task_attempt_failures
      WHERE task_id = ? AND model_step_id = ?`).get(taskId, modelStepId) as { count: number }).count;
  }

  getBusinessFailureReason(taskId: string, modelStepId: string):
    'deadline_expired_without_business_result' | 'gateway_response_without_business_receipt' |
      'provider_failed_without_business_result' | null {
    const row = this.db.prepare(`SELECT reason FROM observer_task_attempt_failures
      WHERE task_id = ? AND model_step_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(taskId, modelStepId) as { reason: string } | undefined;
    if (row?.reason === 'deadline_expired_without_business_result' ||
        row?.reason === 'gateway_response_without_business_receipt' ||
        row?.reason === 'provider_failed_without_business_result') return row.reason;
    return null;
  }

  getTaskBusinessFailureCount(taskId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM observer_task_attempt_failures
      WHERE task_id = ?`).get(taskId) as { count: number }).count;
  }

  listBusinessFailureCounts(taskId: string): Array<{ modelStepId: string; failedAttempts: number }> {
    return this.db.prepare(`SELECT model_step_id AS modelStepId, COUNT(*) AS failedAttempts
      FROM observer_task_attempt_failures WHERE task_id = ? GROUP BY model_step_id
      ORDER BY model_step_id`).all(taskId) as Array<{ modelStepId: string; failedAttempts: number }>;
  }

  listModelStepReports(taskId: string): Array<{ modelStepId: string; actualCalls: number; failedAttempts: number }> {
    return this.db.prepare(`SELECT modelStepId, MAX(actualCalls) AS actualCalls,
        MAX(failedAttempts) AS failedAttempts
      FROM (
        SELECT model_step_id AS modelStepId, actual_calls AS actualCalls, 0 AS failedAttempts
          FROM observer_task_steps WHERE task_id = ?
        UNION ALL
        SELECT model_step_id AS modelStepId, 0 AS actualCalls, COUNT(*) AS failedAttempts
          FROM observer_task_attempt_failures WHERE task_id = ? GROUP BY model_step_id
      ) GROUP BY modelStepId ORDER BY modelStepId`).all(taskId, taskId) as
      Array<{ modelStepId: string; actualCalls: number; failedAttempts: number }>;
  }

  hasUnresolved(sessionDbId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM observer_tasks
      WHERE session_db_id = ? AND (state = 'reconciliation' OR (state IN ('queued', 'running') AND EXISTS (
        SELECT 1 FROM observer_task_commands c WHERE c.task_id = observer_tasks.id
          AND c.action = 'retry' AND c.state = 'started'
      ))) LIMIT 1`).get(sessionDbId);
  }

  hasUnresolvedExcept(sessionDbId: number, taskId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM observer_tasks
      WHERE session_db_id = ? AND id != ? AND (state = 'reconciliation' OR (state IN ('queued', 'running') AND EXISTS (
        SELECT 1 FROM observer_task_commands c WHERE c.task_id = observer_tasks.id
          AND c.action = 'retry' AND c.state = 'started'
      ))) LIMIT 1`)
      .get(sessionDbId, taskId);
  }

  list(state: ObserverTaskState, limit = 100): ObserverTaskRow[] {
    return this.db.prepare(`SELECT id, session_db_id AS sessionDbId,
      content_session_id AS contentSessionId, source_id AS sourceId, payload,
      state, actual_calls AS actualCalls, version, outcome FROM observer_tasks
      WHERE state = ? ORDER BY created_at, id LIMIT ?`).all(state, Math.min(Math.max(limit, 1), 500)) as ObserverTaskRow[];
  }

  listReportableAfter(afterId: string, limit = 20): ObserverTaskRow[] {
    return this.db.prepare(`SELECT id, session_db_id AS sessionDbId,
      content_session_id AS contentSessionId, source_id AS sourceId, payload,
      state, actual_calls AS actualCalls, version, outcome FROM observer_tasks
      WHERE state IN ('queued', 'running', 'reconciliation', 'succeeded', 'skipped', 'failed')
        AND id > ? ORDER BY id LIMIT ?`)
      .all(afterId, Math.min(Math.max(limit, 1), 100)) as ObserverTaskRow[];
  }
}
