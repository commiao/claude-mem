import { ObservationPreparationError } from '../../sdk/observation-field.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

/** Dedicated to one field request; never registers under the main session's
 * process key (that registry intentionally replaces duplicates). */
export function createFieldProcessOwner() {
  let child: ChildProcess | undefined;
  let stopped = false;
  let cleanup: Promise<void> | undefined;
  return {
    spawn(options: SpawnOptions): SpawnedProcess {
      if (stopped) throw new Error('Field request already canceled');
      child = spawn(options.command, options.args, {
        cwd: options.cwd, env: sanitizeEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      return child as SpawnedProcess;
    },
    close(): Promise<void> {
      stopped = true;
      if (cleanup) return cleanup;
      const process = child;
      if (!process || process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
      cleanup = new Promise<void>((resolve, reject) => {
        let force: ReturnType<typeof setTimeout>;
        let deadline: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(force); clearTimeout(deadline);
          process.off('exit', done); process.off('error', failed);
          resolve();
        };
        const failed = (_error: Error) => {
          clearTimeout(force); clearTimeout(deadline);
          process.off('exit', done); process.off('error', failed);
          reject(new ObservationPreparationError('compression-cleanup-unconfirmed'));
        };
        process.once('exit', done); process.once('error', failed);
        force = setTimeout(() => { process.kill('SIGKILL'); }, 1000);
        deadline = setTimeout(() => failed(new ObservationPreparationError('compression-cleanup-unconfirmed')), 2000);
        process.kill('SIGTERM');
      });
      return cleanup;
    },
  };
}
