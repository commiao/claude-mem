import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { optimizeField } from '../../src/services/worker/field-optimizer.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';

test('field deadline cancels real OpenRouter fetch and prevents retries', async () => {
  let requests = 0;
  let disconnected = false;
  // Use Node's HTTP server as an independent wire witness. Bun's node:http
  // compatibility layer can keep req/socket close events silent after fetch
  // abort, making the old fixture fail even on the unchanged main branch.
  const server = spawn('node', ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => {
      process.send({ event: 'request' });
      req.resume();
      res.on('close', () => process.send({ event: 'closed' }));
    });
    server.listen(0, '127.0.0.1', () => process.send({ event: 'ready', port: server.address().port }));
    process.on('message', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once('error', reject);
    server.on('message', (message: any) => {
      if (message.event === 'ready') resolve({ port: message.port });
      if (message.event === 'request') requests++;
      if (message.event === 'closed') disconnected = true;
    });
  });
  const nativeTimeout = globalThis.setTimeout;
  let budgetTimers = 0;
  // query() arms its attempt timeout before optimizeField arms the field deadline.
  // Keep the attempt alive longer so this test exercises field cancellation, not a timer tie.
  globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) =>
    nativeTimeout(fn, ms === 30_000 ? (++budgetTimers === 1 ? 1000 : 100) : ms, ...args)) as typeof setTimeout;
  const provider = new OpenRouterProvider({} as any, {} as any);
  const raw = JSON.stringify({ oldString: 'a', newString: 'b', content: 'x'.repeat(20_000) });
  let signal: AbortSignal | undefined;
  try {
    const result = await optimizeField(raw, (text, budget, abortSignal) => {
      signal = abortSignal;
      return (provider as any).compressField(text, budget, {
        apiKey: 'fixture-not-a-secret', model: 'fixture',
        apiUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      }, abortSignal);
    }, { sessionDbId: 0, field: 'outcome', toolName: 'Edit' });
    await new Promise(resolve => nativeTimeout(resolve, 450));
    expect(result).toBe(raw);
    expect(signal?.aborted).toBe(true);
    expect(requests).toBe(1);
    expect(disconnected).toBe(true);
  } finally {
    globalThis.setTimeout = nativeTimeout;
    const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
    server.send('stop');
    await exited;
  }
}, 5000);
