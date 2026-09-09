import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
ModeManager.getInstance().loadMode('code');
import { normalizeToolResult, serializeObservationField, ObservationPreparationError } from '../../src/sdk/observation-field.js';
import { optimizeField, optimizeObservationFields } from '../../src/services/worker/field-optimizer.js';
import { buildObservationPrompt } from '../../src/sdk/prompts.js';
import { runStandaloneFieldQuery } from '../../src/services/worker/standalone-field-query.js';
import { shouldRecycleConversation } from '../../src/shared/observer-recycle.js';
import { SessionMessageBuffer } from '../../src/services/worker/SessionMessageBuffer.js';
import { deferObservation, retryDeferredObservation, isObservationDeferred } from '../../src/services/worker/deferred-observations.js';
import { initializeSourceRecovery, recoverSourcePass } from '../../src/services/worker/SourceRecovery.js';
import { RecoveryLedger } from '../../src/services/worker/RecoveryLedger.js';
const ctx = { sessionDbId: 1, field: 'outcome', toolName: 'Bash', strict: true };
const markers = ['approved plan must remain outside candidate-mounted directories', 'configuration publication requires durable current Compose identity'];
function prompt(value: unknown) {
  return buildObservationPrompt({ id: 1, tool_name: 'Bash', tool_input: '{}', tool_output: JSON.stringify(value), created_at_epoch: 0 } as any, true);
}
describe('T-0064 evidence admission', () => {
  it('normalizes only the typed envelope once and preserves every key and nested string', async () => {
    const envelope = { stdout: 'a\n'.repeat(3400), stderr: '', exit_code: 0, extra: { raw: '{"x":1}' }, unknown: [null, 3] };
    const raw = JSON.stringify(envelope);
    expect(normalizeToolResult(raw)).toEqual(envelope);
    let calls = 0;
    const result = await optimizeField(raw, async () => { calls++; return null; }, ctx);
    expect(result).toEqual(envelope); expect(calls).toBe(0);
    for (const value of ['{"command":"ls"}', '{"stdout":4,"stderr":"","exit_code":0}', JSON.stringify(raw), '[1,2]']) {
      expect(normalizeToolResult(value)).toBe(value);
    }
  });
  it('preserves middle constraints in an accepted summary and never re-truncates', async () => {
    const original = 'x'.repeat(17000) + markers.join('\n') + 'y'.repeat(17000);
    const result = await optimizeField(original, async () => markers.join('\n'), ctx);
    const actual = prompt(result);
    for (const marker of markers) expect(actual).toContain(marker);
    expect(actual).not.toContain('<elided chars="');
  });
  it('rejects summaries that fit naked but exceed the serialized wrapper budget', async () => {
    const summary = '\\"\n'.repeat(3000);
    expect(summary.length).toBeLessThan(16000);
    await expect(optimizeField('x'.repeat(20000), async () => summary, ctx)).rejects.toThrow('compressed-field-over-budget');
    expect(() => prompt('x'.repeat(17000))).toThrow(ObservationPreparationError);
  });
  it('never retries empty, throwing, or oversized compressors', async () => {
    for (const compress of [async () => null, async () => { throw Error('failure'); }, async () => 'x'.repeat(17000)]) {
      let calls = 0;
      await expect(optimizeField('x'.repeat(20000), async () => { calls++; return compress(); }, ctx)).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
  it('accounts for pending prompt before the old history reaches its cap', () => {
    expect(shouldRecycleConversation([{ role: 'user', content: 'x'.repeat(90) }], 100, 'x'.repeat(10))).toBe(true);
    expect(shouldRecycleConversation([{ role: 'user', content: 'x'.repeat(90) }], 100, 'x'.repeat(9))).toBe(false);
  });
});
function fakeQuery(events: any[], parent: AbortController, delay = 0) {
  let closes = 0, returned = 0, local: AbortController | undefined;
  const create = (controller: AbortController) => {
    local = controller;
    let wake: (() => void) | undefined;
    const generator = (async function* () {
      try {
        if (delay) await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delay);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        for (const event of events) yield event;
      } finally { returned++; }
    })();
    return Object.assign(generator, { close() { closes++; wake?.(); } });
  };
  return { create, stats: () => ({ closes, returned, localAborted: local?.signal.aborted, parentAborted: parent.signal.aborted }) };
}
const success = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'retained summary' }] } }, { type: 'result', subtype: 'success' }];
describe('T-0064 standalone request terminal state', () => {
  it('timeout closes and drains only its own query; no late success is admitted', async () => {
    const parent = new AbortController(); const fake = fakeQuery(success, parent, 10000);
    await expect(optimizeField('x'.repeat(20000), (_t, _b, signal) => runStandaloneFieldQuery(fake.create, parent.signal, signal), { ...ctx, timeoutMs: 5 })).rejects.toThrow('compression-timeout');
    expect(fake.stats()).toEqual({ closes: 1, returned: 1, localAborted: true, parentAborted: false });
  });
  it('successful completion closes once and removes the deadline listener', async () => {
    const parent = new AbortController(), deadline = new AbortController(), fake = fakeQuery(success, parent);
    expect(await runStandaloneFieldQuery(fake.create, parent.signal, deadline.signal)).toBe('retained summary');
    deadline.abort(); parent.abort();
    expect(fake.stats().closes).toBe(1); expect(fake.stats().localAborted).toBe(false);
  });
  it('does not accept partial assistant text followed by a failed terminal result', async () => {
    const parent = new AbortController(), fake = fakeQuery([success[0], { type: 'result', subtype: 'error_during_execution', is_error: true }], parent);
    expect(await runStandaloneFieldQuery(fake.create, parent.signal)).toBeNull();
    expect(fake.stats().closes).toBe(1);
  });
  it('never creates a query for an already canceled session', async () => {
    const parent = new AbortController(); parent.abort(); let calls = 0;
    expect(await runStandaloneFieldQuery(() => { calls++; throw Error(); }, parent.signal)).toBeNull(); expect(calls).toBe(0);
  });
  it('waits for both independent fields to settle before returning failure', async () => {
    let finished = false;
    await expect(optimizeObservationFields({ toolInput: 'i'.repeat(20000), toolOutput: 'o'.repeat(20000) }, async text => {
      if (text.includes('iii')) throw Error('input failed');
      await new Promise(resolve => setTimeout(resolve, 10)); finished = true; return 'ok';
    }, ctx)).rejects.toThrow();
    expect(finished).toBe(true);
  });
});
describe('T-0064 durable deferral and identity', () => {
  it('holds original evidence without confirming it, excludes automatic replay, and retries once explicitly', async () => {
    const db = new Database(':memory:'); initializeSourceRecovery(db);
    const buffer = new SessionMessageBuffer(); const manager = { getMessageBuffer: () => buffer } as any;
    const original = { type: 'observation', toolUseId: 'tool-1', tool_name: 'Bash', tool_response: markers.join('\n'), tool_input: {} } as any;
    const id = buffer.enqueue(1, original), other = buffer.enqueue(1, { ...original, toolUseId: 'tool-2' });
    const session = { sessionDbId: 1, contentSessionId: 'session', claimedMessageIds: [id, other], abortController: new AbortController() } as any;
    const message = buffer.getMessagesByIds(1, [id])[0];
    db.query('INSERT INTO source_event_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('session', 'tool-1', '/missing-source', 'codex', '/', 0, 0, null);
    deferObservation(db, session, manager, message, 'compression-timeout');
    expect(session.claimedMessageIds).toEqual([other]);
    expect(session.abortController.signal.aborted).toBe(false);
    expect(new RecoveryLedger(db).has('session', 'tool-1')).toBe(false);
    expect(isObservationDeferred(db, 'session', 'tool-1')).toBe(true);
    expect((await recoverSourcePass(db, async () => { throw Error('must not retry'); })).selected).toBe(0);
    expect(JSON.parse((db.query('SELECT payload FROM deferred_observations').get() as any).payload).tool_response).toBe(original.tool_response);
    const retry = retryDeferredObservation(db, session, manager, 'tool-1');
    expect(retryDeferredObservation(db, session, manager, 'tool-1')).toBe(retry);
    expect(buffer.getPendingCount(1)).toBe(2);
    expect(buffer.getMessagesByIds(1, [retry])[0].toolUseId).toBe('tool-1');
    const ledger = new RecoveryLedger(db);
    expect(() => ledger.commit('session', ['tool-1'], 'stored', () => { throw Error('db failure'); })).toThrow();
    expect(isObservationDeferred(db, 'session', 'tool-1')).toBe(true);
    ledger.commit('session', ['tool-1'], 'stored', () => {});
    expect(isObservationDeferred(db, 'session', 'tool-1')).toBe(false);
    expect(retryDeferredObservation(db, session, manager, 'tool-1')).toBe(0);
    db.close();
  });
});

describe('T-0064 actual Claude message generator', () => {
  it('continues after a deferred message and sends the next observation intact', async () => {
    const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
    const db = new Database(':memory:');
    const buffer = new SessionMessageBuffer();
    const ids = [buffer.enqueue(1, { type: 'observation', toolUseId: 'bad', tool_name: 'Bash', tool_input: {}, tool_response: 'x'.repeat(20000) }),
      buffer.enqueue(1, { type: 'observation', toolUseId: 'good', tool_name: 'Bash', tool_input: {}, tool_response: markers.join('\n') })];
    const session = { sessionDbId: 1, contentSessionId: 'integration', project: 'test', userPrompt: 'test', lastPromptNumber: 1,
      conversationHistory: [], claimedMessageIds: [], abortController: new AbortController() } as any;
    const manager = { getMessageBuffer: () => buffer, async *getMessageIterator() {
      for (const id of ids) { session.claimedMessageIds.push(id); yield buffer.getMessagesByIds(1, [id])[0]; }
    } } as any;
    const provider = new ClaudeProvider({ getSessionStore: () => ({ db }) } as any, manager) as any;
    const prompts = [];
    for await (const message of provider.createMessageGenerator(session, {}, { current: {} }, undefined, async () => null)) prompts.push(message.message.content);
    expect(prompts.length).toBe(2); // init + good, not a truncated bad observation
    expect(prompts[1]).toContain(markers[0]); expect(prompts[1]).toContain(markers[1]);
    expect(session.claimedMessageIds).toEqual([ids[1]]);
    expect(isObservationDeferred(db, 'integration', 'bad')).toBe(true);
    expect(session.abortController.signal.aborted).toBe(false);
    db.close();
  });
  it('checks the complete pending observation and recycles without confirming its identity', async () => {
    const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
    const db = new Database(':memory:');
    const session = { sessionDbId: 1, contentSessionId: 'budget-test', project: 'test', userPrompt: 'test', lastPromptNumber: 1,
      conversationHistory: [{ role: 'assistant', content: 'h'.repeat(12000) }], claimedMessageIds: [42], abortController: new AbortController() } as any;
    let reset = 0;
    const manager = { async *getMessageIterator() { yield { type: 'observation', _persistentId: 42, toolUseId: 'stable', tool_name: 'Bash', tool_input: {}, tool_response: 'result' }; },
      async resetProcessingToPending() { reset++; session.claimedMessageIds = []; } } as any;
    const provider = new ClaudeProvider({ getSessionStore: () => ({ db }) } as any, manager) as any;
    const generator = provider.createMessageGenerator(session, {}, { current: {} }, undefined, async () => null);
    const first = await generator.next();
    provider.conversationMaxChars = () => first.value.message.content.length + 12001;
    expect((await generator.next()).done).toBe(true);
    expect(reset).toBe(1); expect(session.abortReason).toBe('overflow:recycle');
    expect(new RecoveryLedger(db).has('budget-test', 'stable')).toBe(false);
    db.close();
  });
});

describe('T-0064 explicit recovery HTTP boundary', () => {
  it('rejects a mismatched session and preserves the hold until a real receipt', async () => {
    const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');
    const db = new Database(':memory:'); const buffer = new SessionMessageBuffer();
    const session = { sessionDbId: 1, contentSessionId: 'correct', claimedMessageIds: [] } as any;
    const manager = { getMessageBuffer: () => buffer, initializeSession: () => session } as any;
    const id = buffer.enqueue(1, { type: 'observation', toolUseId: 'tool', tool_name: 'Bash', tool_input: {}, tool_response: 'retained' });
    deferObservation(db, session, manager, buffer.getMessagesByIds(1, [id])[0], 'compression-timeout');
    const routes = new SessionRoutes(manager, { getSessionStore: () => ({ db, getSessionById: () => ({ content_session_id: 'correct' }) }) } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
    let starts = 0; routes.ensureGeneratorRunning = async () => { starts++; };
    const handlers = new Map<string, any>();
    routes.setupRoutes({ get: () => {}, post: (path: string, ...functions: any[]) => handlers.set(path, functions.at(-1)) } as any);
    const handler = handlers.get('/api/observations/deferred/retry');
    let status = 200, result: any;
    const response = { status(n: number) { status = n; return this; }, json(x: any) { result = x; } };
    await handler({ body: { sessionDbId: 1, contentSessionId: 'wrong', toolUseId: 'tool', reviewedReason: 'fixed' } }, response);
    expect(status).toBe(409); expect(starts).toBe(0);
    await handler({ body: { sessionDbId: 1, contentSessionId: 'correct', toolUseId: 'tool', reviewedReason: 'fixed' } }, response);
    expect(result.status).toBe('queued'); expect(starts).toBe(1);
    expect(isObservationDeferred(db, 'correct', 'tool')).toBe(true);
    expect(buffer.getPendingCount(1)).toBe(1);
    db.close();
  });
});

it('cancellation wins over a terminal success arriving in the same iteration', async () => {
  const parent = new AbortController(), deadline = new AbortController(); let closed = 0;
  const create = () => Object.assign((async function* () {
    yield success[0]; deadline.abort(); yield success[1];
  })(), { close() { closed++; } });
  expect(await runStandaloneFieldQuery(create, parent.signal, deadline.signal)).toBeNull();
  expect(closed).toBe(1); expect(parent.signal.aborted).toBe(false);
});
it('does not remove a queued identity when persisting deferral fails', () => {
  const db = new Database(':memory:'); initializeSourceRecovery(db);
  db.exec("CREATE TRIGGER fail_deferral BEFORE INSERT ON deferred_observations BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  const buffer = new SessionMessageBuffer(), id = buffer.enqueue(1, { type: 'observation', toolUseId: 'keep', tool_name: 'Bash' });
  const session = { sessionDbId: 1, contentSessionId: 'session', claimedMessageIds: [id] } as any;
  expect(() => deferObservation(db, session, { getMessageBuffer: () => buffer } as any, buffer.getMessagesByIds(1, [id])[0], 'failure')).toThrow('disk failure');
  expect(buffer.getPendingCount(1)).toBe(1); expect(session.claimedMessageIds).toEqual([id]); db.close();
});

it('installed SDK cancellation reaps a real subprocess without contacting a model', async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { createFieldProcessOwner } = await import('../../src/services/worker/field-process-owner.js');
  const owner = createFieldProcessOwner(), parent = new AbortController();
  let child: any;
  try {
    await expect(optimizeField('x'.repeat(20000), (_text, _budget, signal) => runStandaloneFieldQuery(controller => query({
      prompt: 'offline lifecycle test',
      options: {
        abortController: controller, pathToClaudeCodeExecutable: process.execPath,
        spawnClaudeCodeProcess: options => {
          child = owner.spawn({ ...options, command: process.execPath,
            args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] });
          return child;
        },
      },
    }), parent.signal, signal, owner.close), { ...ctx, timeoutMs: 100 })).rejects.toThrow('compression-timeout');
    expect(child).toBeDefined();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  } finally { await owner.close(); }
});

it('force-reaps only its owned child when graceful termination is ignored', async () => {
  const { createFieldProcessOwner } = await import('../../src/services/worker/field-process-owner.js');
  const owner = createFieldProcessOwner();
  const child = owner.spawn({ command: process.execPath,
    args: ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], env: {} });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
    await owner.close();
    expect(child.signalCode).toBe('SIGKILL');
    await owner.close();
  } finally { await owner.close(); }
});

it('preserves a deferred original across a database close and reopen', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(tmpdir() + '/t0064-durable-'), path = directory + '/test.db';
  let db = new Database(path);
  const buffer = new SessionMessageBuffer();
  const id = buffer.enqueue(1, { type: 'observation', toolUseId: 'durable', tool_name: 'Bash', tool_response: markers.join('\n') });
  const session = { sessionDbId: 1, contentSessionId: 'session', claimedMessageIds: [id] } as any;
  try {
    deferObservation(db, session, { getMessageBuffer: () => buffer } as any, buffer.getMessagesByIds(1, [id])[0], 'compression-timeout');
    db.close(); db = new Database(path);
    const freshBuffer = new SessionMessageBuffer();
    const retry = retryDeferredObservation(db, session, { getMessageBuffer: () => freshBuffer } as any, 'durable');
    expect(freshBuffer.getMessagesByIds(1, [retry])[0].tool_response).toBe(markers.join('\n'));
    expect(new RecoveryLedger(db).has('session', 'durable')).toBe(false);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('surfaces cleanup failure without admitting the answer or retrying', async () => {
  const parent = new AbortController(); let calls = 0;
  await expect(optimizeField('x'.repeat(20000), (_text, _budget, signal) => {
    calls++;
    return runStandaloneFieldQuery(() => Object.assign((async function* () { for (const event of success) yield event; })(), {
      close() { throw Error('close failed'); },
    }), parent.signal, signal);
  }, ctx)).rejects.toThrow('compression-cleanup-unconfirmed');
  expect(calls).toBe(1); expect(parent.signal.aborted).toBe(false);
});
