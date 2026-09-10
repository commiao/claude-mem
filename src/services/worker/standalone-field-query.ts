import { ObservationPreparationError } from '../../sdk/observation-field.js';
/** Owns just the field query. close() is the SDK resource-termination API;
 * abort never propagates from this request to the main observation session. */
export async function runStandaloneFieldQuery(
  create: (controller: AbortController) => AsyncIterable<any> & { close(): void; return?(value?: any): Promise<any> },
  parent: AbortSignal, deadline?: AbortSignal,
  cleanup: () => Promise<void> = async () => {},
): Promise<string | null> {
  const controller = new AbortController();
  let result: (AsyncIterable<any> & { close(): void; return?(value?: any): Promise<any> }) | undefined;
  let closed = false;
  let cleanupPromise: Promise<void> | undefined;
  let closeFailed = false;
  const close = () => {
    cleanupPromise ??= Promise.resolve().then(cleanup);
    // Attach a rejection handler immediately; finally still propagates failure.
    void cleanupPromise.catch(() => {});
    if (result && !closed) {
      closed = true;
      try { result.close(); } catch { closeFailed = true; }
    }
  };
  const abort = () => { controller.abort(); close(); };
  parent.addEventListener('abort', abort, { once: true });
  deadline?.addEventListener('abort', abort, { once: true });
  try {
    if (parent.aborted || deadline?.aborted) return null;
    result = create(controller);
    if (controller.signal.aborted) { close(); return null; }
    let out = '', success = false;
    for await (const message of result) {
      if (controller.signal.aborted) return null;
      if (message.type === 'assistant') {
        if (message.error) return null;
        const content = message.message.content;
        out += Array.isArray(content) ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : typeof content === 'string' ? content : '';
      }
      if (message.type === 'result') success = message.subtype === 'success' && !message.is_error;
    }
    return !controller.signal.aborted && success ? out || null : null;
  } finally {
    try {
      close(); await Promise.all([result?.return?.(), cleanupPromise]);
      if (closeFailed) throw new ObservationPreparationError('compression-cleanup-unconfirmed');
    } finally {
      parent.removeEventListener('abort', abort);
      deadline?.removeEventListener('abort', abort);
    }
  }
}
