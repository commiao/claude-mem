import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionMessageBuffer } from '../../src/services/worker/SessionMessageBuffer.js';
import { initializeSourceRecovery, recoverSourcePass } from '../../src/services/worker/SourceRecovery.js';

describe('bounded observation ingress', () => {
  test('holds new work at either per-session or global capacity without evicting queued work', () => {
    const buffer = new SessionMessageBuffer();
    const limits = { maxPerSession: 2, maxTotal: 3 };
    expect(buffer.admitObservation(1, { type: 'observation', toolUseId: 'a' }, limits).status).toBe('queued');
    expect(buffer.admitObservation(1, { type: 'observation', toolUseId: 'b' }, limits).status).toBe('queued');
    expect(buffer.admitObservation(1, { type: 'observation', toolUseId: 'c' }, limits)).toEqual({ status: 'held', reason: 'per_session_capacity' });
    expect(buffer.admitObservation(2, { type: 'observation', toolUseId: 'd' }, limits).status).toBe('queued');
    expect(buffer.admitObservation(3, { type: 'observation', toolUseId: 'e' }, limits)).toEqual({ status: 'held', reason: 'global_capacity' });
    expect(buffer.getTotalDepth()).toBe(3);
  });

  test('source recovery stops at the first held source item and leaves all remaining references recoverable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mem-ingress-hold-'));
    const source = join(directory, 'source.jsonl');
    const db = new Database(':memory:');
    try {
      writeFileSync(source, [
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'first', command: ['true'], cwd: '/repo', stdout: '', stderr: '', exit_code: 0 } } },
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'second', command: ['true'], cwd: '/repo', stdout: '', stderr: '', exit_code: 0 } } },
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'third', command: ['true'], cwd: '/repo', stdout: '', stderr: '', exit_code: 0 } } },
      ].map(JSON.stringify).join('\n') + '\n');
      initializeSourceRecovery(db);
      for (const toolUseId of ['first', 'second', 'third']) {
        db.query('INSERT INTO source_event_refs (content_session_id,tool_use_id,source_path,platform,cwd,registered_at) VALUES (?,?,?,?,?,?)')
          .run('session', toolUseId, source, 'codex', '/repo', Date.now());
      }
      const submitted: string[] = [];
      const result = await recoverSourcePass(db, async payload => {
        submitted.push(payload.toolUseId);
        return submitted.length === 1
          ? { ok: true }
          : { ok: true, status: 'held', reason: 'queue_capacity' };
      });
      expect(submitted).toEqual(['first', 'second']);
      expect(result).toEqual({ selected: 3, submitted: 1, errors: 0 });
      expect(db.query('SELECT COUNT(*) AS count FROM source_event_refs').get()).toEqual({ count: 3 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
