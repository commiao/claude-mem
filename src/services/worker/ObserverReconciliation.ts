import type { ObserverTaskStore, ObserverTaskRow } from './ObserverTaskStore.js';

export const UNKNOWN_MODEL_STEP_ID = '0'.repeat(64);

export interface ObserverReconciliationReport {
  task_id: string;
  model_step_id: string;
  business_state: 'succeeded' | 'skipped' | 'failed' | 'reconciliation';
  version: number;
  failed_attempts: number;
  max_attempts: 3;
  retryable: false;
  reason: string;
}

interface GatewayAttempt {
  identity: string;
  model_step_id: string;
  phase: string;
  provider_call_started: boolean | null;
  in_flight?: boolean | null;
  deadline_at?: string | null;
}

interface GatewayTaskResponse {
  task_id: string;
  attempts: GatewayAttempt[];
}

export class ObserverReconciliation {
  constructor(
    private readonly store: ObserverTaskStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Read gateway evidence; never submit a model request or authorize retry. */
  async check(taskId: string, forwarderUrl: string, apiKey: string): Promise<ObserverReconciliationReport[]> {
    const task = this.store.get(taskId);
    if (!task) throw new Error('observer_task_not_found');
    if (task.state === 'succeeded' || task.state === 'skipped' || task.state === 'failed') {
      return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, task.state, 'local_business_outcome')];
    }
    if (task.state !== 'reconciliation') {
      return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', 'task_not_ready_for_check')];
    }
    if (!apiKey) return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', 'gateway_credentials_unavailable')];

    let response: Response;
    try {
      response = await this.fetcher(new URL('/v1/task-attempts', forwarderUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ business_key: 'claude_mem.observation', task_id: taskId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', 'gateway_unreachable')];
    }
    if (!response.ok) return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', `gateway_http_${response.status}`)];

    let body: GatewayTaskResponse;
    try {
      body = await response.json() as GatewayTaskResponse;
    } catch {
      return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', 'gateway_invalid_response')];
    }
    if (body.task_id !== taskId || !Array.isArray(body.attempts)) {
      return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', 'gateway_identity_mismatch')];
    }
    if (body.attempts.length === 0) {
      return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', 'no_exact_step_evidence')];
    }

    const grouped = new Map<string, GatewayAttempt[]>();
    for (const attempt of body.attempts) {
      if (!/^[a-f0-9]{64}$/i.test(attempt.model_step_id)) {
        return [this.report(task, UNKNOWN_MODEL_STEP_ID, 0, 'reconciliation', 'gateway_invalid_step_identity')];
      }
      const list = grouped.get(attempt.model_step_id) ?? [];
      list.push(attempt);
      grouped.set(attempt.model_step_id, list);
    }

    const reports: ObserverReconciliationReport[] = [];
    for (const [stepId, attempts] of grouped) {
      if (attempts.some(attempt => !/^[a-f0-9]{64}$/i.test(attempt.identity))) {
        reports.push(this.report(task, stepId, 0, 'reconciliation', 'gateway_invalid_attempt_identity'));
        continue;
      }
      const uncertain = attempts.some(attempt => {
        if (attempt.phase === 'unknown' || attempt.phase === 'absent' ||
            attempt.provider_call_started === null) return true;
        if (attempt.phase === 'preflight') return attempt.provider_call_started !== false;
        if (attempt.phase === 'completed' || attempt.phase === 'failed') {
          return attempt.provider_call_started !== true;
        }
        if (attempt.phase === 'admitted') {
          const deadline = attempt.deadline_at ? Date.parse(attempt.deadline_at) : NaN;
          return attempt.provider_call_started !== true || attempt.in_flight !== false ||
            !Number.isFinite(deadline) || Date.now() < deadline;
        }
        return true;
      });
      if (uncertain) {
        reports.push(this.report(task, stepId, 0, 'reconciliation', 'model_call_state_unknown_or_in_flight'));
        continue;
      }
      const calls = new Set(attempts
        .filter(attempt => attempt.provider_call_started === true)
        .map(attempt => attempt.identity)).size;
      this.store.recordStepWitness(taskId, stepId, calls);
      const current = this.store.get(taskId)!;
      reports.push(this.report(
        current, stepId, Math.min(calls, 3),
        current.state === 'failed' ? 'failed' : 'reconciliation',
        current.state === 'failed' ? 'three_model_calls_failed' : 'business_outcome_not_persisted',
      ));
    }
    return reports;
  }

  private report(
    task: ObserverTaskRow,
    stepId: string,
    failedAttempts: number,
    state: ObserverReconciliationReport['business_state'],
    reason: string,
  ): ObserverReconciliationReport {
    return {
      task_id: task.id,
      model_step_id: stepId,
      business_state: state,
      version: task.version,
      failed_attempts: failedAttempts,
      max_attempts: 3,
      retryable: false,
      reason,
    };
  }
}
