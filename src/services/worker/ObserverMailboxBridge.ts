import type { ObserverTaskStore, ObserverTaskRow } from './ObserverTaskStore.js';
import { readFileSync, statSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { createHash } from 'crypto';

const BUSINESS_KEY = 'claude_mem.observation';
const STEP_ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RECONCILIATION_CLAIM_LEASE_MS = 300_000;

interface MailboxCommand {
  command_id: string;
  task_id: string;
  model_step_id: string;
  action: 'check' | 'retry' | 'reconcile';
  expected_version: number;
  lease_token: string;
}

interface GatewayAttempt {
  model_step_id: string;
  identity: string;
  phase: string;
  in_flight: boolean | null;
  http_request_started_at: string | null;
  http_request_deadline_at: string | null;
  deadline_at?: string | null;
}

interface GatewayEvidence {
  taskId: string;
  startedCalls: number;
  newlyFailedCalls: number;
  newlyFailedReason: 'deadline_expired_without_business_result' |
    'gateway_response_without_business_receipt' | 'provider_failed_without_business_result' | null;
  hasUnresolvedFlight: boolean;
  hasCompletedResponse: boolean;
}

type Post = (path: string, body: Record<string, unknown>) => Promise<unknown>;

export interface ManualReplayExecution {
  started: boolean;
  reason: string;
  completed: Promise<void> | null;
  release?: () => void;
}

export interface ManualReplayDispatcher {
  dispatch(input: {
    commandId: string;
    taskId: string;
    modelStepId: string;
    observedVersion: number;
    admission: { permitId: string; idempotencyKey: string; promptDigest: string; baselineActualCalls: number };
  }): Promise<ManualReplayExecution>;
  observe?(commandId: string, taskId: string): ManualReplayExecution;
}

/** Manual reconciliation and prompt-free task status over the authenticated loopback forwarder. */
export class ObserverMailboxBridge {
  private cursor = '';
  private busy = false;
  private stopped = false;
  private lastLoggedFailure: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tasks: ObserverTaskStore,
    private readonly post: Post,
    private readonly replayDispatcher?: ManualReplayDispatcher,
  ) {}

  static forLoopback(tasks: ObserverTaskStore, baseUrl: string, callerTokenFile: string,
    replayDispatcher?: ManualReplayDispatcher): ObserverMailboxBridge {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error('observer_mailbox_requires_loopback_forwarder');
    }
    const tokenFile = statSync(callerTokenFile);
    if (!tokenFile.isFile() || (tokenFile.mode & 0o077) !== 0 || tokenFile.uid !== process.getuid?.()) {
      throw new Error('observer_mailbox_token_file_must_be_owner_0600');
    }
    const token = readFileSync(callerTokenFile, 'utf8').trim();
    if (!token || /[\r\n]/.test(token)) throw new Error('observer_mailbox_token_invalid');
    return new ObserverMailboxBridge(tasks, async (path, body) => {
      const response = await fetch(new URL(path, url), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`observer_mailbox_http_${response.status}`);
      return response.json();
    }, replayDispatcher);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(error => this.logTickFailure(error)); }, 10_000);
    this.timer.unref?.();
    void this.tick().catch(error => this.logTickFailure(error));
  }

  private logTickFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : '';
    const reason = /^observer_(?:mailbox|command|status)_[a-z0-9_]+$/.test(message)
      ? message
      : 'transport_or_processing_error';
    if (reason !== this.lastLoggedFailure) {
      logger.warn('WORKER', 'Observer reconciliation mailbox tick failed', { reason });
      this.lastLoggedFailure = reason;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private state(row: ObserverTaskRow | null): 'queued' | 'running' | 'reconciliation' | 'succeeded' | 'skipped' | 'failed' {
    if (row?.state === 'succeeded' && row.outcome) return 'succeeded';
    if (row?.state === 'skipped') return 'skipped';
    if (row?.state === 'failed') return 'failed';
    if (row?.state === 'queued' || row?.state === 'running') return row.state;
    return 'reconciliation';
  }

  private async report(row: ObserverTaskRow,
    command?: { modelStepId: string; reason: string }, refreshStatus = true): Promise<void> {
    // A fresh status read discovers exact HTTP body hashes, including a hash
    // created by manual replay. Never publish a synthetic placeholder step.
    if (refreshStatus && ['queued', 'running', 'reconciliation'].includes(row.state)) {
      const status = await this.post('/v1/task-attempts', { business_key: BUSINESS_KEY, task_id: row.id });
      this.recordAttemptEvidence(row.id, status);
      row = this.tasks.get(row.id) ?? row;
    }

    const taskFailures = Math.min(this.tasks.getTaskBusinessFailureCount(row.id), 3);
    const retryable = row.state === 'reconciliation' && taskFailures < 3 && row.actualCalls < 3;
    const steps = new Map(this.tasks.listModelStepReports(row.id).map(step => [step.modelStepId, step]));
    if (command && !steps.has(command.modelStepId)) {
      steps.set(command.modelStepId, { modelStepId: command.modelStepId, actualCalls: 0,
        failedAttempts: this.tasks.getBusinessFailureCount(row.id, command.modelStepId) });
    }
    for (const step of steps.values()) {
      const reason = command?.modelStepId === step.modelStepId ? command.reason :
        row.state === 'succeeded' && row.outcome ? 'business_result_persisted' :
        row.state === 'skipped' ? 'valid_business_skip' :
        row.state === 'failed' ? row.outcome ?? 'terminal_failure_persisted' :
        row.state === 'running' ? 'manual_replay_running' :
        row.state === 'queued' ? 'manual_replay_queued' :
        step.failedAttempts > 0 ? 'deadline_expired_without_business_result' :
        'business_result_unconfirmed';
      await this.post('/v1/reconciliation/report', {
        business_key: BUSINESS_KEY, task_id: row.id, model_step_id: step.modelStepId,
        state: this.state(row), version: row.version, failed_attempts: taskFailures,
        max_attempts: 3, retryable, reason,
      });
    }
  }

  private recordAttemptEvidence(taskId: string, status: unknown): GatewayEvidence {
    const result = status as { task_id?: string; attempts?: GatewayAttempt[]; external_calls?: number };
    if (result.external_calls !== 0 || result.task_id !== taskId || !Array.isArray(result.attempts)) {
      throw new Error('invalid_observer_status_query');
    }
    const startedByStep = new Map<string, Set<string>>();
    const observedSteps = new Set<string>();
    const identityToStep = new Map<string, string>();
    let newlyFailedCalls = 0;
    let newlyFailedReason: GatewayEvidence['newlyFailedReason'] = null;
    let hasUnresolvedFlight = false;
    let hasCompletedResponse = false;
    const now = Date.now();
    for (const attempt of result.attempts) {
      if (!attempt || typeof attempt.phase !== 'string' ||
          !['absent', 'admitted', 'completed', 'failed', 'preflight', 'unknown'].includes(attempt.phase) ||
          (attempt.in_flight !== true && attempt.in_flight !== false && attempt.in_flight !== null) ||
          (attempt.http_request_started_at !== null && typeof attempt.http_request_started_at !== 'string') ||
          (attempt.http_request_deadline_at !== null && typeof attempt.http_request_deadline_at !== 'string') ||
          (attempt.deadline_at !== undefined && attempt.deadline_at !== null && typeof attempt.deadline_at !== 'string')) {
        throw new Error('invalid_observer_gateway_attempt');
      }
      if (!STEP_ID.test(attempt.model_step_id) || !STEP_ID.test(attempt.identity)) {
        throw new Error('invalid_observer_gateway_attempt');
      }
      observedSteps.add(attempt.model_step_id);
      const startedAt = attempt.http_request_started_at === null ? NaN : Date.parse(attempt.http_request_started_at);
      const deadlineValue = attempt.http_request_deadline_at ?? attempt.deadline_at ?? null;
      const deadlineAt = deadlineValue === null ? NaN : Date.parse(deadlineValue);
      const hasStarted = Number.isFinite(startedAt);
      if (attempt.http_request_started_at !== null && !hasStarted) throw new Error('invalid_observer_gateway_attempt');
      if (deadlineValue !== null && !Number.isFinite(deadlineAt)) {
        throw new Error('invalid_observer_gateway_attempt');
      }
      if (attempt.phase === 'completed') hasCompletedResponse = true;

      // Only transport-start witnesses consume the call budget. Distinct
      // gateway identities are deduplicated so a repeated status read cannot
      // increment the durable count.
      if (hasStarted) {
        const priorStep = identityToStep.get(attempt.identity);
        if (priorStep && priorStep !== attempt.model_step_id) {
          throw new Error('observer_gateway_identity_step_conflict');
        }
        identityToStep.set(attempt.identity, attempt.model_step_id);
        let identities = startedByStep.get(attempt.model_step_id);
        if (!identities) startedByStep.set(attempt.model_step_id, identities = new Set());
        identities.add(attempt.identity);
        if (attempt.phase !== 'completed' &&
            !(Number.isFinite(deadlineAt) && deadlineAt <= now) &&
            !(attempt.phase === 'failed' && attempt.in_flight === false)) {
          hasUnresolvedFlight = true;
        }
      } else if (['admitted', 'unknown'].includes(attempt.phase) &&
          (!Number.isFinite(deadlineAt) || deadlineAt > now)) {
        // Admission without a transport start is not a billable call, but keep
        // it unresolved until its conservative gateway deadline has elapsed.
        hasUnresolvedFlight = true;
      }

      // The provider's terminal HTTP error or an expired no-response deadline
      // proves a failed model call. Before the deadline, an in-flight request
      // remains pending; after the authoritative deadline, a stale in-flight
      // flag cannot keep a no-result call unresolved. Billing is irrelevant.
      const terminalFailure = attempt.phase === 'failed' && attempt.in_flight === false;
      const expiredWithoutResult = attempt.phase !== 'completed' &&
        Number.isFinite(deadlineAt) && deadlineAt <= now;
      const currentTask = this.tasks.get(taskId);
      const completedWithoutReceipt = attempt.phase === 'completed' &&
        currentTask?.state === 'reconciliation' && !currentTask.outcome;
      const failed = hasStarted && (terminalFailure || expiredWithoutResult || completedWithoutReceipt);
      if (failed) {
        const before = this.tasks.getBusinessFailureCount(taskId, attempt.model_step_id);
        const reason = completedWithoutReceipt ? 'gateway_response_without_business_receipt' as const :
          terminalFailure ? 'provider_failed_without_business_result' as const :
          'deadline_expired_without_business_result' as const;
        const after = this.tasks.recordFailedBusinessAttempt(taskId, attempt.model_step_id, attempt.identity, reason);
        if (after > before) {
          newlyFailedCalls++;
          newlyFailedReason ??= reason;
        }
      }
    }
    for (const modelStepId of observedSteps) {
      this.tasks.recordStepWitness(taskId, modelStepId, startedByStep.get(modelStepId)?.size ?? 0);
    }
    return {
      taskId,
      startedCalls: [...startedByStep.values()].reduce((total, identities) => total + identities.size, 0),
      newlyFailedCalls,
      newlyFailedReason,
      hasUnresolvedFlight,
      hasCompletedResponse,
    };
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const rows = this.tasks.listReportableAfter(this.cursor, 20);
      for (const row of rows) {
        if (this.stopped) return;
        await this.report(row);
        this.cursor = row.id;
      }
      if (rows.length < 20) this.cursor = '';
      if (this.stopped) return;
      const claimed = await this.post('/v1/reconciliation/claim', { business_key: BUSINESS_KEY }) as
        { command?: MailboxCommand | null };
      if (claimed.command) await this.handle(claimed.command);
      this.lastLoggedFailure = null;
    } finally {
      this.busy = false;
    }
  }

  private async handle(command: MailboxCommand): Promise<void> {
    if (!UUID.test(command.command_id) || !UUID.test(command.task_id) ||
        !STEP_ID.test(command.model_step_id) || command.model_step_id === '0'.repeat(64) ||
        !Number.isSafeInteger(command.expected_version) || command.expected_version < 0 ||
        !['check', 'retry', 'reconcile'].includes(command.action) || !command.lease_token) {
      throw new Error('invalid_observer_mailbox_command');
    }
    const isReconcile = command.action !== 'check';
    const localClaim = isReconcile
      ? this.tasks.beginRetryCommand(command.command_id, command.task_id, command.model_step_id)
      : this.tasks.beginCheckCommand(command.command_id, command.task_id, command.model_step_id);
    if (!localClaim.finished) {
      const claimedAt = Date.now();
      let reason = 'business_result_unconfirmed';
      let current = this.tasks.get(command.task_id);
      let evidence: GatewayEvidence | null = null;

      if (!current) reason = 'business_task_not_found';
      else if (current.state === 'succeeded' && current.outcome) reason = 'business_result_persisted';
      else if (current.state === 'skipped') reason = 'valid_business_skip';
      else if (current.state === 'failed') reason = current.outcome ?? 'terminal_failure_persisted';
      else if (current.version !== command.expected_version && !localClaim.duplicate) reason = 'version_conflict';
      else {
        const status = await this.post('/v1/task-attempts', {
          business_key: BUSINESS_KEY, task_id: command.task_id,
        });
        evidence = this.recordAttemptEvidence(command.task_id, status);
        current = this.tasks.get(command.task_id);

        if (!current) reason = 'business_task_not_found';
        else if (current.state === 'succeeded' && current.outcome) reason = 'business_result_persisted';
        else if (current.state === 'skipped') reason = 'valid_business_skip';
        else if (current.state === 'failed') reason = current.outcome ?? 'three_failed_business_attempts';
        else if (evidence.hasUnresolvedFlight && isReconcile && this.replayDispatcher) {
          const existingAdmission = this.tasks.getManualReplayAdmission(command.command_id, command.task_id);
          if (existingAdmission) {
            const execution = this.replayDispatcher.observe?.(command.command_id, command.task_id) ?? {
              started: true, reason: 'manual_replay_already_started', completed: null,
            };
            reason = await this.waitForReplay(command, claimedAt,
              existingAdmission.baselineActualCalls, execution);
          } else reason = 'gateway_attempt_in_flight_or_unknown';
        }
        else if (evidence.hasUnresolvedFlight) reason = 'gateway_attempt_in_flight_or_unknown';
        else if (isReconcile && current.state === 'reconciliation') {
          const failures = this.tasks.getTaskBusinessFailureCount(command.task_id);
          if (current.actualCalls >= 3 || failures >= 3) {
            reason = 'call_budget_exhausted_without_business_result';
          } else if (command.action === 'check') {
            reason = failures > 0 ? 'manual_retry_available' : 'business_result_unconfirmed';
          } else {
            const existingAdmission = this.tasks.getManualReplayAdmission(command.command_id, command.task_id);
            if (existingAdmission) {
              // A command that already entered the original queue is never
              // dispatched again. Redelivery only follows its persisted work.
              if (this.replayDispatcher) {
                const execution = this.replayDispatcher.observe?.(command.command_id, command.task_id) ?? {
                  started: true, reason: 'manual_replay_already_started', completed: null,
                };
                reason = await this.waitForReplay(command, claimedAt,
                  existingAdmission.baselineActualCalls, execution);
              } else reason = 'manual_replay_runtime_unavailable';
            } else if (!this.replayDispatcher) {
              reason = 'manual_replay_runtime_unavailable';
            } else {
              const prepared = this.tasks.getPreparedPrompt(command.task_id);
              const promptDigest = prepared
                ? createHash('sha256').update(prepared.prompt, 'utf8').digest('hex') : '';
              const marker = `[[cm-task:${command.task_id}]]`;
              const markerCount = prepared?.prompt.match(/\[\[cm-task:[^\]]+\]\]/g)?.length ?? 0;
              if (!prepared || !prepared.promptDigest || prepared.promptDigest !== promptDigest ||
                  markerCount !== 1 || !prepared.prompt.includes(marker) ||
                  prepared.enqueuedAtEpoch !== current.enqueuedAtEpoch) {
                reason = 'prepared_prompt_identity_unavailable';
              } else {
                const execution = await this.replayDispatcher.dispatch({
                  commandId: command.command_id, taskId: command.task_id,
                  modelStepId: command.model_step_id, observedVersion: current.version,
                  admission: {
                    permitId: command.command_id,
                    idempotencyKey: `cmretry-${command.command_id}`,
                    promptDigest,
                    baselineActualCalls: current.actualCalls,
                  },
                });
                reason = execution.started
                  ? await this.waitForReplay(command, claimedAt, current.actualCalls, execution)
                  : execution.reason;
              }
            }
          }
        } else if (evidence.newlyFailedCalls > 0) {
          reason = evidence.newlyFailedReason ?? 'provider_failed_without_business_result';
        } else if (evidence.hasCompletedResponse) {
          reason = 'gateway_response_without_business_receipt';
        } else if (this.tasks.getBusinessFailureCount(command.task_id, command.model_step_id) > 0) {
          reason = this.tasks.getBusinessFailureReason(command.task_id, command.model_step_id) ??
            'provider_failed_without_business_result';
        }
      }

      current = this.tasks.get(command.task_id);
      const version = current
        ? this.tasks.advanceVersionForCommand(current.id, command.expected_version)
        : command.expected_version + 1;
      const latest = this.tasks.get(command.task_id);
      if (isReconcile) {
        this.tasks.finishRetryCommand(command.command_id, command.task_id,
          this.state(latest), latest?.version ?? version, reason);
      } else {
        this.tasks.finishCheckCommand(command.command_id, command.task_id,
          this.state(latest), latest?.version ?? version, reason);
      }
    }

    const saved = this.tasks.getCommandResult(command.command_id);
    if (!saved) throw new Error('observer_command_result_missing');
    const reportable = this.tasks.get(command.task_id);
    if (reportable) await this.report(reportable,
      { modelStepId: command.model_step_id, reason: saved.reason }, false);
    await this.post('/v1/reconciliation/complete', {
      business_key: BUSINESS_KEY, command_id: command.command_id,
      lease_token: command.lease_token, result_state: saved.state,
      result_version: saved.version, result_reason: saved.reason,
    });
  }

  private async waitForReplay(command: MailboxCommand, claimedAt: number, initialCalls: number,
    execution: ManualReplayExecution): Promise<string> {
    let providerFinished = execution.completed === null;
    if (execution.completed) {
      void execution.completed.then(() => { providerFinished = true; }, () => { providerFinished = true; });
    }
    let lastReportedVersion = -1;
    try { while (!this.stopped) {
      let current = this.tasks.get(command.task_id);
      if (!current) return 'business_task_not_found';
      if (current.state === 'succeeded' && current.outcome) return 'business_result_persisted';
      if (current.state === 'skipped') return 'valid_business_skip';
      if (current.state === 'failed') return current.outcome ?? 'three_failed_business_attempts';

      const status = await this.post('/v1/task-attempts', {
        business_key: BUSINESS_KEY, task_id: command.task_id,
      });
      const evidence = this.recordAttemptEvidence(command.task_id, status);
      current = this.tasks.get(command.task_id);
      if (!current) return 'business_task_not_found';
      if (current.state === 'succeeded' && current.outcome) return 'business_result_persisted';
      if (current.state === 'skipped') return 'valid_business_skip';
      if (current.state === 'failed') return current.outcome ?? 'three_failed_business_attempts';

      const started = current.actualCalls > initialCalls;
      if (started && current.version !== lastReportedVersion) {
        // Publish progress only after the Gateway has witnessed the actual HTTP start.
        await this.report(current, { modelStepId: command.model_step_id, reason: 'manual_replay_running' }, false);
        lastReportedVersion = current.version;
      }
      if (evidence.newlyFailedCalls > 0) return 'model_call_failed_manual_retry_required';

      if (providerFinished && !evidence.hasUnresolvedFlight) {
        if (!started) {
          if (current.state === 'running') this.tasks.needsReconciliation([command.task_id]);
          return 'manual_replay_no_http_start';
        }
        if (evidence.hasCompletedResponse) {
          // The provider completed, but no durable business receipt exists.
          // Provider completion is the boundary after which the local task can
          // safely leave running; a Gateway response alone is not a receipt.
          const latest = this.tasks.get(command.task_id);
          if (latest?.state === 'running') this.tasks.needsReconciliation([command.task_id]);
          const reconciling = this.tasks.get(command.task_id);
          if (reconciling?.state === 'reconciliation') {
            const finalStatus = await this.post('/v1/task-attempts', {
              business_key: BUSINESS_KEY, task_id: command.task_id,
            });
            this.recordAttemptEvidence(command.task_id, finalStatus);
            const afterFailure = this.tasks.get(command.task_id);
            if (afterFailure?.state === 'failed') return afterFailure.outcome ?? 'three_failed_business_attempts';
            if ((afterFailure?.actualCalls ?? 0) >= 3) return 'call_budget_exhausted_without_business_result';
            return 'model_call_completed_without_business_receipt_manual_retry_required';
          }
        }
        return 'manual_replay_finished_without_business_receipt';
      }

      if (!started && Date.now() >= claimedAt + RECONCILIATION_CLAIM_LEASE_MS) {
        // The command permit expires at the Gateway. A provider process still
        // parked on its slot can only be rejected before a later upstream start.
        if (current.state === 'running') this.tasks.needsReconciliation([command.task_id]);
        return 'manual_replay_no_start_lease_expired';
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return 'observer_mailbox_stopped';
    } finally {
      execution.release?.();
    }
  }
}
