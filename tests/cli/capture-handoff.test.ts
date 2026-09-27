import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { journalCaptureHandoff } from '../../src/cli/capture-handoff.js';
let root: string;
let db: Database;
let priorControl: string | undefined;
let priorReplay: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-handoff-test-'));
  priorControl = process.env.CLAUDE_MEM_HANDOFF_CONTROL;
  priorReplay = process.env.CLAUDE_MEM_HANDOFF_REPLAY;
  delete process.env.CLAUDE_MEM_HANDOFF_REPLAY;
  const journal = join(root, 'journal.db');
  process.env.CLAUDE_MEM_HANDOFF_CONTROL = join(root, 'control.json');
  writeFileSync(process.env.CLAUDE_MEM_HANDOFF_CONTROL, JSON.stringify({ generation: 'g', journal }));
  db = new Database(journal);
  db.exec("CREATE TABLE handoff_control(id INTEGER PRIMARY KEY,generation TEXT,phase TEXT); INSERT INTO handoff_control VALUES(1,'g','capture'); CREATE TABLE handoff_events(id INTEGER PRIMARY KEY,platform TEXT,event TEXT,payload TEXT,state TEXT);");
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true });
  if (priorControl === undefined) delete process.env.CLAUDE_MEM_HANDOFF_CONTROL; else process.env.CLAUDE_MEM_HANDOFF_CONTROL = priorControl;
  if (priorReplay === undefined) delete process.env.CLAUDE_MEM_HANDOFF_REPLAY; else process.env.CLAUDE_MEM_HANDOFF_REPLAY = priorReplay;
});
const input = { sessionId: 'source', cwd: '/tmp', prompt: '<private>secret</private>' };
test('persists original and normalized privacy input before acknowledging', () => {
  expect(journalCaptureHandoff('codex', 'session-init', { prompt: input.prompt }, input)).toBe(true);
  const row = db.query('SELECT * FROM handoff_events').get() as any;
  expect(row.state).toBe('queued');
  expect(JSON.parse(row.payload).normalizedInput.prompt).toBe(input.prompt);
});
test('closed gate routes later hooks live without journaling', () => {
  db.exec("UPDATE handoff_control SET phase='closed'");
  expect(journalCaptureHandoff('codex', 'observation', {}, input)).toBe(false);
  expect((db.query('SELECT count(*) AS n FROM handoff_events').get() as any).n).toBe(0);
});
test('replay does not capture itself and must match generation', () => {
  process.env.CLAUDE_MEM_HANDOFF_REPLAY = 'g';
  expect(journalCaptureHandoff('codex', 'observation', {}, input)).toBe(false);
  process.env.CLAUDE_MEM_HANDOFF_REPLAY = 'other';
  expect(() => journalCaptureHandoff('codex', 'observation', {}, input)).toThrow('generation mismatch');
});
test('invalid phase never silently bypasses durable capture', () => {
  db.exec("UPDATE handoff_control SET phase='broken'");
  expect(() => journalCaptureHandoff('codex', 'observation', {}, input)).toThrow('Unknown');
});
test('already supplied summary is frozen without reopening its transcript', () => {
  expect(journalCaptureHandoff('codex', 'summarize', {}, { ...input, lastAssistantMessage: 'original summary', transcriptPath: '/missing' })).toBe(true);
  const row = db.query('SELECT payload FROM handoff_events').get() as any;
  expect(JSON.parse(row.payload).normalizedInput.lastAssistantMessage).toBe('original summary');
});

test('handoff delivery rejects HTTP failures instead of acknowledging a fallback', async () => {
  const { executeWithWorkerFallback } = await import('../../src/shared/worker-utils.js');
  const originalFetch = globalThis.fetch;
  process.env.CLAUDE_MEM_HANDOFF_REPLAY = 'g';
  try {
    for (const status of [400, 429, 503]) {
      globalThis.fetch = (async (url: any) => new Response('{}', {
        status: String(url).endsWith('/api/readiness') ? 200 : status,
      })) as typeof fetch;
      await expect(executeWithWorkerFallback('/api/sessions/observations', 'POST', {}, {
        workerStartupTimeoutMs: 1000,
      })).rejects.toThrow(`Handoff worker returned ${status}`);
    }
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/api/readiness')) return new Response('{}');
      throw new Error('connection lost after request');
    }) as typeof fetch;
    await expect(executeWithWorkerFallback('/api/sessions/observations', 'POST', {}, {
      workerStartupTimeoutMs: 1000,
    })).rejects.toThrow('connection lost');
  } finally { globalThis.fetch = originalFetch; }
});
