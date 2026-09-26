import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverTaskStore } from '../../src/services/worker/ObserverTaskStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

const PERMIT = '598ef2c1-5479-4a8a-a081-7ce206d144d0';

describe('dormant prepared observer replay', () => {
  it('reconstructs only one task in the original session queue and never starts a generator', async () => {
    const db = new Database(':memory:');
    const previous = process.env.CLAUDE_MEM_EXPERIMENTAL_REPLAY_QUEUE;
    try {
      const tasks = new ObserverTaskStore(db);
      const taskId = tasks.create({ sessionDbId: 23, contentSessionId: 's23', sourceId: 'tool-23',
        enqueuedAtEpoch: 1_700_000_000_123,
        payload: JSON.stringify({ tool_name: 'Read', tool_input: '{"path":"a"}',
          tool_response: '{"ok":true}', prompt_number: 2, cwd: '/tmp', toolUseId: 'tool-23' }) });
      const prepared = tasks.recordPreparedPrompt(taskId, `[[cm-task:${taskId}]]`, 1_700_000_000_123);
      tasks.needsReconciliation([taskId]);
      const databaseManager = {
        getObserverTaskStore: () => tasks,
        getSessionById: () => ({ content_session_id: 's23', memory_session_id: null,
          project: '/tmp', platform_source: 'claude-code', observed_model: null,
          observed_billing: null, user_prompt: 'prompt' }),
        getSessionStore: () => ({ getLatestPromptTextFromUserPrompts: () => null,
          getPromptNumberFromUserPrompts: () => 2 }),
      } as unknown as DatabaseManager;
      let verifications = 0;
      const manager = new SessionManager(databaseManager, { verify: async input => {
        verifications++;
        expect(input).toEqual({ taskId, promptDigest: prepared.promptDigest, expectedVersion: 1 });
        return { permitId: PERMIT, cacheOnlyPrefixReady: true, taskWideHttpGateReady: true };
      } });
      delete process.env.CLAUDE_MEM_EXPERIMENTAL_REPLAY_QUEUE;
      expect(await manager.queuePreparedReplay(taskId, 1)).toBe(false);
      expect(verifications).toBe(0);
      process.env.CLAUDE_MEM_EXPERIMENTAL_REPLAY_QUEUE = 'enabled';
      expect(await manager.queuePreparedReplay(taskId, 1)).toBe(true);
      expect(await manager.queuePreparedReplay(taskId, 1)).toBe(false);
      expect(verifications).toBe(1);
      expect(manager.getSession(23)?.generatorPromise).toBeNull();
      const next = await manager.getMessageIterator(23).next();
      expect(next.value).toMatchObject({ recoveryTaskId: taskId,
        originalTimestamp: 1_700_000_000_123, _originalTimestamp: 1_700_000_000_123,
        manualReplayPermitId: PERMIT, tool_name: 'Read' });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_EXPERIMENTAL_REPLAY_QUEUE;
      else process.env.CLAUDE_MEM_EXPERIMENTAL_REPLAY_QUEUE = previous;
      db.close();
    }
  });
});
