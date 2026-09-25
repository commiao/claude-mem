import type { ObserverTaskStore, ObserverTaskRow } from './ObserverTaskStore.js';
import { readFileSync, statSync } from 'fs';

const BUSINESS_KEY = 'claude_mem.observation';
const UNKNOWN_STEP = '0'.repeat(64);
const STEP_ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface MailboxCommand {
  command_id: string;
  task_id: string;
  model_step_id: string;
  action: 'check' | 'retry';
  expected_version: number;
  lease_token: string;
}

type Post = (path: string, body: Record<string, unknown>) => Promise<unknown>;

/** Read-only business reconciliation over the owner-authenticated loopback forwarder. */
export class ObserverMailboxBridge {
  private cursor = '';
  private busy = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly tasks: ObserverTaskStore, private readonly post: Post) {}

  static forLoopback(tasks: ObserverTaskStore, baseUrl: string, callerTokenFile: string): ObserverMailboxBridge {
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
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 10_000);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private state(row: ObserverTaskRow | null): 'reconciliation' | 'succeeded' | 'skipped' | 'failed' {
    if (row?.state === 'succeeded' && row.outcome) return 'succeeded';
    if (row?.state === 'skipped') return 'skipped';
    if (row?.state === 'failed') return 'failed';
    return 'reconciliation';
  }

  private async report(row: ObserverTaskRow): Promise<void> {
    // The source payload and prompt must never leave the worker in status reports.
    await this.post('/v1/reconciliation/report', {
      business_key: BUSINESS_KEY, task_id: row.id, model_step_id: UNKNOWN_STEP,
      state: this.state(row), version: row.version, failed_attempts: 0,
      max_attempts: 3, retryable: false,
      reason: row.state === 'succeeded' && row.outcome ? 'business_result_persisted' :
        row.state === 'skipped' ? 'valid_business_skip' :
        row.state === 'failed' ? 'terminal_failure_persisted' : 'model_step_identity_unproven',
    });
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
    } finally {
      this.busy = false;
    }
  }

  private async handle(command: MailboxCommand): Promise<void> {
    if (!UUID.test(command.command_id) || !UUID.test(command.task_id) ||
        !STEP_ID.test(command.model_step_id) ||
        !Number.isSafeInteger(command.expected_version) || command.expected_version < 0 ||
        !['check', 'retry'].includes(command.action) || !command.lease_token) {
      throw new Error('invalid_observer_mailbox_command');
    }
    if (command.action === 'retry') {
      // SDK internal model calls have no proven stable semantic step ID yet.
      // Persist this command as finished so lease re-delivery can never enqueue work.
      this.tasks.rejectUnverifiableRetry(command.command_id, command.task_id, command.model_step_id);
    } else {
      const claim = this.tasks.beginCheckCommand(command.command_id, command.task_id, command.model_step_id);
      if (!claim.finished) {
        const row = this.tasks.get(command.task_id);
        let reason = 'model_step_identity_unproven';
        if (!row) reason = 'business_task_not_found';
        else if (row.version !== command.expected_version) reason = 'version_conflict';
        else if (row.state === 'succeeded' && row.outcome) reason = 'business_result_persisted';
        else if (row.state === 'skipped') reason = 'valid_business_skip';
        else if (row.state === 'failed') reason = 'terminal_failure_persisted';
        else {
          // This status request does not call a model. Its gateway result cannot
          // substitute for a persisted business outcome or stable retry identity.
          const status = await this.post('/v1/task-attempts', {
            business_key: BUSINESS_KEY, task_id: command.task_id,
          }) as { external_calls?: number };
          if (status.external_calls !== 0) throw new Error('observer_status_query_not_zero_call');
          reason = 'business_result_unconfirmed';
        }
        this.tasks.finishCheckCommand(command.command_id, command.task_id,
          this.state(row), row?.version ?? 0, reason);
      }
    }
    const saved = this.tasks.getCommandResult(command.command_id);
    if (!saved) throw new Error('observer_command_result_missing');
    await this.post('/v1/reconciliation/complete', {
      business_key: BUSINESS_KEY, command_id: command.command_id,
      lease_token: command.lease_token, result_state: saved.state,
      result_version: saved.version, result_reason: saved.reason,
    });
  }
}
