import { logger } from '../../../utils/logger.js';

/** Keep SDK prompt prefetch from outrunning the response/claim acknowledgement. */
export class ObserverTurnGate {
  private pending: Promise<boolean> = Promise.resolve(true);
  private resolve?: (completed: boolean) => void;
  private readonly onAbort = () => this.finish(false);

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  begin(): void {
    if (this.resolve) {
      logger.error('SDK', 'Observer input advanced before the prior result');
      throw new Error('Observer turn already in flight');
    }
    this.pending = this.signal.aborted
      ? Promise.resolve(false)
      : new Promise(resolve => { this.resolve = resolve; });
  }

  wait(): Promise<boolean> {
    return this.signal.aborted ? Promise.resolve(false) : this.pending;
  }

  complete(): void { this.finish(true); }

  dispose(): void {
    this.signal.removeEventListener('abort', this.onAbort);
    this.finish(false);
  }

  private finish(completed: boolean): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(completed);
  }
}
