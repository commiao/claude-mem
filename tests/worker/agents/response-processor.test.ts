import { SessionManager as RealSessionManager } from '../../../src/services/worker/SessionManager.js';
import { describe, test, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { logger } from '../../../src/utils/logger.js';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these partial stubs do not leak
// into later test files (bun's mock.module is process-global; mock.restore()
// does NOT undo it). A leaked ModeManager stub (no class prototype, no
// loadMode) breaks tests/server/server-boot.test.ts, server-runtime-smoke and
// the tests/sdk parser suites; leaked worker-service/worker-utils stubs break
// any later file that imports the real modules.
import * as realWorkerServiceModule from '../../../src/services/worker-service.js';
import * as realWorkerUtilsModule from '../../../src/shared/worker-utils.js';
import * as realModeManagerModule from '../../../src/services/domain/ModeManager.js';

const realWorkerServiceSnapshot = { ...realWorkerServiceModule };
const realWorkerUtilsSnapshot = { ...realWorkerUtilsModule };
const realModeManagerSnapshot = { ...realModeManagerModule };

afterAll(() => {
  mock.module('../../../src/services/worker-service.js', () => realWorkerServiceSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
});

function mockSettingsDefaults(): Record<string, string> {
  return {
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: mockFolderClaudeMdEnabled,
    CLAUDE_MEM_QUEUE_ENGINE: 'sqlite',
    CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true',
    CLAUDE_MEM_WORKER_PORT: '37777',
  };
}

function mockSettingsFromFile(settingsPath?: string, applyEnvOverrides = true): Record<string, string> {
  const settings = settingsPath && existsSync(settingsPath)
    ? { ...mockSettingsDefaults(), ...JSON.parse(readFileSync(settingsPath, 'utf-8')) }
    : mockSettingsDefaults();

  if (!applyEnvOverrides) {
    settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED = mockFolderClaudeMdEnabled;
    return settings;
  }

  for (const key of Object.keys(settings)) {
    if (key === 'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED') {
      continue;
    }
    settings[key] = process.env[key] ?? settings[key];
  }
  settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED = mockFolderClaudeMdEnabled;

  return settings;
}

mock.module('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../../src/utils/claude-md-utils.js', () => ({
  updateFolderClaudeMdFiles: (...args: unknown[]) => mockUpdateFolderClaudeMdFiles(...args),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    getAllDefaults: () => mockSettingsDefaults(),
    get: (key: string) => process.env[key] ?? mockSettingsDefaults()[key] ?? '',
    getInt: (key: string) => parseInt(process.env[key] ?? mockSettingsDefaults()[key] ?? '0', 10),
    loadFromFile: (settingsPath?: string, applyEnvOverrides = true) =>
      mockSettingsFromFile(settingsPath, applyEnvOverrides),
  },
}));

mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {
          init: 'init prompt',
          observation: 'obs prompt',
          summary: 'summary prompt',
        },
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    }),
  },
}));

import {
  extractObservationFileEvidence,
  processAgentResponse,
  type ResponseContext,
} from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let mockFolderClaudeMdEnabled = false;
let mockUpdateFolderClaudeMdFiles: ReturnType<typeof mock>;
let claimedMessages: Array<{
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: unknown;
  toolUseId?: string;
}> = [];
let mockGetClaimedMessages: ReturnType<typeof mock>;

describe('ResponseProcessor', () => {
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockChromaSyncObservation: ReturnType<typeof mock>;
  let mockChromaSyncSummary: ReturnType<typeof mock>;
  let mockBroadcast: ReturnType<typeof mock>;
  let mockBroadcastProcessingStatus: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let mockWorker: WorkerRef;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    mockFolderClaudeMdEnabled = false;
    claimedMessages = [];
    mockUpdateFolderClaudeMdFiles = mock(() => Promise.resolve());
    mockGetClaimedMessages = mock(() => claimedMessages);

    mockStoreObservations = mock(() => ({
      observationIds: [1, 2],
      summaryId: 1,
      createdAtEpoch: 1700000000000,
    } as StorageResult));

    mockChromaSyncObservation = mock(() => Promise.resolve());
    mockChromaSyncSummary = mock(() => Promise.resolve());

    mockDbManager = {
      getSessionStore: () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),  // FK fix (Issue #846)
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),  // FK fix (Issue #846)
      }),
      getChromaSync: () => ({
        syncObservation: mockChromaSyncObservation,
        syncSummary: mockChromaSyncSummary,
      }),
      getCloudSync: () => null,
    } as unknown as DatabaseManager;

    mockSessionManager = {
      getMessageIterator: async function* () {
        yield* [];
      },
      getPendingMessageStore: () => ({
        markProcessed: mock(() => {}),
        confirmProcessed: mock(() => {}),  // CLAIM-CONFIRM pattern: confirm after successful storage
        cleanupProcessed: mock(() => 0),
        resetStuckMessages: mock(() => 0),
      }),
      getClaimedMessages: mockGetClaimedMessages,
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;

    mockBroadcast = mock(() => {});
    mockBroadcastProcessingStatus = mock(() => {});

    mockWorker = {
      sseBroadcaster: {
        broadcast: mockBroadcast,
      },
      broadcastProcessingStatus: mockBroadcastProcessingStatus,
    };
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function createMockSession(
    overrides: Partial<ActiveSession> = {}
  ): ActiveSession {
    return {
      sessionDbId: 1,
      contentSessionId: 'content-session-123',
      memorySessionId: 'memory-session-456',
      project: 'test-project',
      userPrompt: 'Test prompt',
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 5,
      startTime: Date.now(),
      cumulativeInputTokens: 100,
      cumulativeOutputTokens: 50,
      earliestPendingTimestamp: Date.now() - 10000,
      claimedMessageIds: [],
      conversationHistory: [],
      currentProvider: 'claude',
      consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0,
      ...overrides,
    } as ActiveSession;
  }

  describe('parsing observations from XML response', () => {
    it('should parse single observation from response', async () => {
      const session = createMockSession({ project: 'repo-b/worktree' });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Found important pattern</title>
          <subtitle>In auth module</subtitle>
          <narrative>Discovered reusable authentication pattern.</narrative>
          <facts><fact>Uses JWT</fact></facts>
          <concepts><concept>authentication</concept></concepts>
          <files_read><file>src/auth.ts</file></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      const [memorySessionId, project, observations, summary] =
        mockStoreObservations.mock.calls[0];
      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('repo-b/worktree');
      expect(mockChromaSyncObservation.mock.calls[0][2]).toBe('repo-b/worktree');
      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe('discovery');
      expect(observations[0].title).toBe('Found important pattern');
    });

    it('should parse multiple observations from response', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>First discovery</title>
          <narrative>First narrative</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
        <observation>
          <type>bugfix</type>
          <title>Fixed null pointer</title>
          <narrative>Second narrative</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , observations] = mockStoreObservations.mock.calls[0];
      expect(observations).toHaveLength(2);
      expect(observations[0].type).toBe('discovery');
      expect(observations[1].type).toBe('bugfix');
    });

    it('stores observations against the dispatched prompt context when the live session has already advanced', async () => {
      const session = createMockSession({
        project: 'repo-b/worktree',
        lastPromptNumber: 2,
        pendingAgentId: 'agent-new',
        pendingAgentType: 'coder',
      });
      const responseContext: ResponseContext = {
        project: 'repo-a',
        promptNumber: 1,
        pendingAgentId: 'agent-old',
        pendingAgentType: 'planner',
      };
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Late response</title>
          <narrative>Stored on the original prompt context.</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent',
        undefined,
        undefined,
        responseContext
      );

      const [, project, observations, , promptNumber] = mockStoreObservations.mock.calls[0];
      expect(project).toBe('repo-a');
      expect(promptNumber).toBe(1);
      expect(observations[0].agent_id).toBe('agent-old');
      expect(observations[0].agent_type).toBe('planner');
      expect(mockChromaSyncObservation.mock.calls[0][2]).toBe('repo-a');
      expect(mockBroadcast.mock.calls[0][0].observation.project).toBe('repo-a');
      expect(mockBroadcast.mock.calls[0][0].observation.prompt_number).toBe(1);
    });
  });

  describe('file evidence sanitization', () => {
    it('enforces the provenance contract for read and write evidence', () => {
      const evidence = extractObservationFileEvidence([
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/read.ts' } },
        { type: 'observation', tool_name: 'write_file', tool_input: { filePath: 'src/write.ts', edits: [] } },
        {
          type: 'observation',
          tool_name: 'apply_patch',
          tool_input: '*** Update File: src/patch.ts\n@@\n-old\n+new\n',
        },
        {
          type: 'observation',
          tool_name: 'apply_patch',
          tool_input: JSON.stringify({ patch: '*** Update File: src/json-patch.ts\n@@\n-old\n+new\n' }),
        },
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/read.ts' } },
      ]);

      expect(evidence.files_read).toEqual(['src/read.ts']);
      expect(evidence.files_modified).toEqual(['src/write.ts', 'src/patch.ts', 'src/json-patch.ts']);
    });
  });

  describe('observation file metadata gating', () => {
    it('drops fabricated files_modified while preserving read evidence', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'supabase/functions/edge/index.ts' } },
      ];

      const session = createMockSession();
      const responseText = `
        <observation>
          <type>bugfix</type>
          <title>Secured edge function access</title>
          <narrative>Completed the security work.</narrative>
          <facts><fact>Observed read-only inspection</fact></facts>
          <concepts><concept>security</concept></concepts>
          <files_read><file>supabase/functions/edge/index.ts</file></files_read>
          <files_modified><file>supabase/functions/edge/index.ts</file></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      const [, , observations] = mockStoreObservations.mock.calls[0];
      expect(observations[0].files_read).toEqual(['supabase/functions/edge/index.ts']);
      expect(observations[0].files_modified).toEqual([]);
    });

    it('populates files_modified from captured write evidence when XML omits it', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'write_file', tool_input: { filePath: 'src/services/worker/agents/ResponseProcessor.ts', edits: [{ type: 'replace' }] } },
      ];

      const session = createMockSession();
      const responseText = `
        <observation>
          <type>bugfix</type>
          <title>Wrote the fix</title>
          <narrative>Captured write evidence drives stored metadata.</narrative>
          <facts><fact>Write evidence present</fact></facts>
          <concepts><concept>storage</concept></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , observations] = mockStoreObservations.mock.calls[0];
      expect(observations[0].files_modified).toEqual(['src/services/worker/agents/ResponseProcessor.ts']);
    });

    it('keeps native records scoped to their originating project', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/native.ts' } },
      ];

      const session = createMockSession({ project: 'origin-project' });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Native scope</title>
          <facts><fact>Project stays unchanged</fact></facts>
          <concepts><concept>scoping</concept></concepts>
          <files_read><file>src/native.ts</file></files_read>
          <files_modified><file>src/native.ts</file></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [memorySessionId, project] = mockStoreObservations.mock.calls[0];
      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('origin-project');
    });

    it('stores worktree-adopted records under the parent project scope', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/parent.ts' } },
      ];

      const session = createMockSession({ project: 'parent-project' });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Adopted scope</title>
          <facts><fact>Parent project owns the stored row</fact></facts>
          <concepts><concept>scoping</concept></concepts>
          <files_read><file>src/parent.ts</file></files_read>
          <files_modified><file>src/parent.ts</file></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [memorySessionId, project] = mockStoreObservations.mock.calls[0];
      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('parent-project');
    });

    it('preserves read-only batches while clearing only files_modified', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/read-only.ts' } },
      ];

      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Read-only batch</title>
          <narrative>Read evidence should stay visible.</narrative>
          <facts><fact>Read evidence present</fact></facts>
          <concepts><concept>evidence</concept></concepts>
          <files_read></files_read>
          <files_modified><file>src/fabricated.ts</file></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , observations] = mockStoreObservations.mock.calls[0];
      expect(observations[0].files_read).toEqual(['src/read-only.ts']);
      expect(observations[0].files_modified).toEqual([]);
    });
  });

  describe('durable completion integration', () => {
    it('commits receipts with actual response output and deduplicates after SessionManager restart', async () => {
      const db = new Database(':memory:');
      try {
        db.exec('CREATE TABLE outputs(id)');
        const store = { ...mockDbManager.getSessionStore(), db,
          storeObservations: () => { db.run('INSERT INTO outputs VALUES (1)'); return {observationIds: [],summaryId:null,createdAtEpoch:Date.now()}; } };
        mockDbManager.getSessionStore = () => store as any;
        claimedMessages = [{type:'observation',toolUseId:'durable-call'}];
        const session = createMockSession();
        await processAgentResponse('<observation><type>discovery</type><title>Durable test</title><narrative>Recorded.</narrative></observation>',
          session,mockDbManager,mockSessionManager,undefined,0,null,'TestAgent');
        expect(new RecoveryLedger(db).has(session.contentSessionId,'durable-call')).toBe(true);
        expect(db.query('SELECT * FROM outputs').all()).toHaveLength(1);
        const restarted = new RealSessionManager(mockDbManager);
        spyOn(restarted,'initializeSession').mockReturnValue(session);
        await restarted.queueObservation(1,{tool_name:'Read',tool_input:'{}',tool_response:'{}',prompt_number:1,cwd:'/repo',toolUseId:'durable-call'});
        expect(restarted.getMessageBuffer().getTotalDepth()).toBe(0);
      } finally { db.close(); }
    });
    it('does not confirm in-memory work if receipt persistence fails', async () => {
      const db = new Database(':memory:');
      try {
        new RecoveryLedger(db);
        db.exec("CREATE TABLE outputs(id); CREATE TRIGGER reject_receipt BEFORE INSERT ON observation_receipts BEGIN SELECT RAISE(ABORT, 'failure'); END");
        const store = {...mockDbManager.getSessionStore(),db,storeObservations:()=>{
          db.run('INSERT INTO outputs VALUES (1)'); return {observationIds:[],summaryId:null,createdAtEpoch:Date.now()};
        }};
        mockDbManager.getSessionStore=()=>store as any;
        claimedMessages=[{type:'observation',toolUseId:'failed-call'}];
        await expect(processAgentResponse('<observation><type>discovery</type><title>Test</title><narrative>Test</narrative></observation>',
          createMockSession(),mockDbManager,mockSessionManager,undefined,0,null,'TestAgent')).rejects.toThrow();
        expect(db.query('SELECT * FROM outputs').all()).toHaveLength(0);
        expect(mockSessionManager.confirmClaimedMessages).not.toHaveBeenCalled();
      } finally { db.close(); }
    });
  });

  describe('non-XML observer responses', () => {
    it('warns and clears pending work when the observer returns non-XML prose', async () => {
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        getClaimedMessages: mockGetClaimedMessages,
        confirmClaimedMessages,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = 'Skipping — repeated log scan with no new findings.';

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'PARSER',
        expect.stringMatching(/^TestAgent returned non-XML prose response/),
        expect.objectContaining({ sessionId: 1, outputClass: 'prose' })
      );
      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
      expect(session.earliestPendingTimestamp).toBeNull();
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });
  });

  describe('context-window overflow recovery (#3800)', () => {
    function overflowSessionManager() {
      const resetProcessingToPending = mock(() => Promise.resolve(1));
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        getClaimedMessages: mockGetClaimedMessages,
        confirmClaimedMessages,
        resetProcessingToPending,
      } as unknown as SessionManager;
      return { resetProcessingToPending, confirmClaimedMessages };
    }

    it('recycles the conversation and preserves the batch instead of dropping it', async () => {
      const { resetProcessingToPending, confirmClaimedMessages } = overflowSessionManager();
      const session = createMockSession({
        conversationHistory: [
          { role: 'user', content: 'framing' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'observation 1' },
        ],
        consecutiveContextOverflows: 0,
      });

      await processAgentResponse(
        'Prompt is too long', session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      // The batch is preserved for a fresh generator, never confirmed away.
      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(confirmClaimedMessages).not.toHaveBeenCalled();
      // The outgrown conversation is dropped and a fresh one forced.
      expect(session.conversationHistory).toEqual([]);
      expect(session.forceInit).toBe(true);
      expect(session.abortReason).toBe('overflow:recycle');
      expect(session.abortController.signal.aborted).toBe(true);
      expect(session.consecutiveContextOverflows).toBe(1);
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });

    it('does not append the rejection to history — a failure must not enlarge the next request', async () => {
      overflowSessionManager();
      const session = createMockSession({
        conversationHistory: [{ role: 'user', content: 'framing' }],
      });

      await processAgentResponse(
        'Prompt is too long', session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(session.conversationHistory.some(m => m.content.includes('too long'))).toBe(false);
    });

    it('pauses the session once recycling has failed repeatedly, rather than retrying forever', async () => {
      const { resetProcessingToPending, confirmClaimedMessages } = overflowSessionManager();
      // Two recycles already spent; a fresh generation carries only the framing
      // prompt, the session-so-far block and one field-truncated observation, so
      // still not fitting means something else is oversized.
      const session = createMockSession({ consecutiveContextOverflows: 2 });

      await processAgentResponse(
        'Prompt is too long', session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(session.abortReason).toBe('overflow:exhausted');
      expect(session.abortController.signal.aborted).toBe(true);
      // Work is still preserved, and still not silently confirmed away.
      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(confirmClaimedMessages).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'SESSION',
        expect.stringContaining('still does not fit'),
        expect.objectContaining({ consecutiveRecycles: 3 })
      );
    });

    it('clears the overflow counter after a healthy observation so only consecutive failures trip it', async () => {
      const session = createMockSession({ consecutiveContextOverflows: 1 });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Recovered</title>
          <narrative>The recycled conversation produced valid XML.</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(session.consecutiveContextOverflows).toBe(0);
    });

    it('still treats ordinary prose as a benign skip, not an overflow', async () => {
      const { resetProcessingToPending, confirmClaimedMessages } = overflowSessionManager();
      const session = createMockSession();

      await processAgentResponse(
        'Skipping — nothing worth recording here.', session, mockDbManager,
        mockSessionManager, mockWorker, 100, null, 'TestAgent'
      );

      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
      expect(resetProcessingToPending).not.toHaveBeenCalled();
      expect(session.consecutiveContextOverflows).toBe(0);
      expect(session.forceInit).toBeUndefined();
    });
  });

  describe('parsing summary from XML response', () => {
    it('should parse summary from response', async () => {
      const session = createMockSession();
      const responseText = `
        <summary>
          <request>Build login form</request>
          <investigated>Reviewed existing forms</investigated>
          <learned>React Hook Form works well</learned>
          <completed>Form skeleton created</completed>
          <next_steps>Add validation</next_steps>
          <notes>Some notes</notes>
        </summary>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , , summary] = mockStoreObservations.mock.calls[0];
      expect(summary).not.toBeNull();
      expect(summary.request).toBe('Build login form');
      expect(summary.investigated).toBe('Reviewed existing forms');
      expect(summary.learned).toBe('React Hook Form works well');
    });

    it('should handle response without summary', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , , summary] = mockStoreObservations.mock.calls[0];
      expect(summary).toBeNull();
    });
  });

  describe('atomic database transactions', () => {
    it('should call storeObservations atomically', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
        <summary>
          <request>Test request</request>
          <investigated>Test investigated</investigated>
          <learned>Test learned</learned>
          <completed>Test completed</completed>
          <next_steps>Test next steps</next_steps>
        </summary>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        1700000000000,
        'TestAgent'
      );

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);

      const [
        memorySessionId,
        project,
        observations,
        summary,
        promptNumber,
        tokens,
        timestamp,
      ] = mockStoreObservations.mock.calls[0];

      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('test-project');
      expect(observations).toHaveLength(1);
      expect(summary).toBeNull();
      expect(promptNumber).toBe(5);
      expect(tokens).toBe(100);
      expect(timestamp).toBe(1700000000000);
    });
  });

  describe('SSE broadcasting', () => {
    it('should broadcast observations via SSE', async () => {
      const session = createMockSession({ project: 'repo-b/worktree' });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Broadcast Test</title>
          <subtitle>Testing broadcast</subtitle>
          <narrative>Testing SSE broadcast</narrative>
          <facts><fact>Fact 1</fact></facts>
          <concepts><concept>testing</concept></concepts>
          <files_read><file>test.ts</file></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [42],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockBroadcast).toHaveBeenCalled();

      const observationCall = mockBroadcast.mock.calls.find(
        (call: any[]) => call[0].type === 'new_observation'
      );
      expect(observationCall).toBeDefined();
      expect(observationCall[0].observation.id).toBe(42);
      expect(observationCall[0].observation.project).toBe('repo-b/worktree');
      expect(observationCall[0].observation.title).toBe('Broadcast Test');
      expect(observationCall[0].observation.type).toBe('discovery');
    });

    it('should broadcast summary via SSE', async () => {
      mockStoreObservations = mock(() => ({
        observationIds: [],
        summaryId: 99,
        createdAtEpoch: 1700000000000,
      } as StorageResult));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      const session = createMockSession();
      const responseText = `
        <summary>
          <request>Build feature</request>
          <investigated>Reviewed code</investigated>
          <learned>Found patterns</learned>
          <completed>Feature built</completed>
          <next_steps>Add tests</next_steps>
        </summary>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const summaryCall = mockBroadcast.mock.calls.find(
        (call: any[]) => call[0].type === 'new_summary'
      );
      expect(summaryCall).toBeDefined();
      expect(summaryCall[0].summary.request).toBe('Build feature');
    });
  });

  describe('handling empty / non-XML response', () => {
    it('clears pending work and does NOT call storeObservations on empty response', async () => {
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        getClaimedMessages: mockGetClaimedMessages,
        confirmClaimedMessages,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = '';

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('clears pending work and does NOT call storeObservations on plain-text response', async () => {
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        getClaimedMessages: mockGetClaimedMessages,
        confirmClaimedMessages,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = 'This is just plain text without any XML tags.';

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
      expect(session.earliestPendingTimestamp).toBeNull();
    });
  });

  describe('session cleanup', () => {
    it('should reset earliestPendingTimestamp after processing', async () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
      });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should call broadcastProcessingStatus after processing', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockBroadcastProcessingStatus).toHaveBeenCalled();
    });
  });

  describe('conversation history', () => {
    it('should add assistant response to conversation history', async () => {
      const session = createMockSession({
        conversationHistory: [],
      });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(session.conversationHistory).toHaveLength(1);
      expect(session.conversationHistory[0].role).toBe('assistant');
      expect(session.conversationHistory[0].content).toBe(responseText);
    });
  });

  describe('error handling', () => {
    it('should reset processing work if memorySessionId is missing from session', async () => {
      const resetProcessingToPending = mock(() => Promise.resolve(1));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        resetProcessingToPending,
      } as unknown as SessionManager;
      const session = createMockSession({
        memorySessionId: null, // Missing memory session ID
      });
      const responseText = `<observation>
        <type>discovery</type>
        <title>some title</title>
        <narrative>some narrative</narrative>
      </observation>`;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });
  });

  describe('lastSummaryStored tracking (#1633)', () => {
    it('should set lastSummaryStored=true when storage returns a summaryId', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: 42,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession();
      const responseText = `
        <summary>
          <request>user asked to fix bug</request>
          <investigated>looked at auth module</investigated>
          <learned>JWT tokens were expiring</learned>
          <completed>fixed expiry check</completed>
          <next_steps>write tests</next_steps>
        </summary>
      `;

      await processAgentResponse(responseText, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(session.lastSummaryStored).toBe(true);
    });

    it('should set lastSummaryStored=false when storage returns summaryId=null (silent loss path, #1633)', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession();
      const responseText = '<skip_summary/>';

      await processAgentResponse(responseText, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(session.lastSummaryStored).toBe(false);
    });
  });
});

import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryLedger, completeObservationBatch } from '../../../src/services/worker/RecoveryLedger.js';
import { readCodexEvents, isCompleted, replayUncompleted } from '../../../src/services/transcripts/recover-codex.js';

describe('durable observation completion cursor', () => {
  test('result and receipt both roll back when storage fails; only committed IDs survive reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-recovery-'));
    const file = join(dir, 'test.db');
    let db = new Database(file);
    try {
      db.exec('CREATE TABLE outputs (id TEXT PRIMARY KEY)');
      const ledger = new RecoveryLedger(db);
      expect(() => ledger.commit('s', ['a'], 'stored', () => {
        db.run("INSERT INTO outputs VALUES ('a')"); throw new Error('crash before commit');
      })).toThrow('crash before commit');
      expect(ledger.has('s', 'a')).toBe(false);
      expect(db.query('SELECT * FROM outputs').all()).toHaveLength(0);
      ledger.commit('s', ['b'], 'stored', () => db.transaction(() => db.run("INSERT INTO outputs VALUES ('b')"))());
      db.close(); db = new Database(file);
      const restored = new RecoveryLedger(db);
      expect(restored.has('s', 'a')).toBe(false);
      expect(restored.has('s', 'b')).toBe(true);
      expect(restored.has('other', 'b')).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('receipt write failure rolls back already stored output', () => {
    const db = new Database(':memory:');
    try {
      const ledger = new RecoveryLedger(db);
      db.exec("CREATE TABLE outputs(id); CREATE TRIGGER fail_receipt BEFORE INSERT ON observation_receipts BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
      expect(() => ledger.commit('s', ['a'], 'stored', () => db.run('INSERT INTO outputs VALUES (1)'))).toThrow();
      expect(db.query('SELECT * FROM outputs').all()).toHaveLength(0);
    } finally { db.close(); }
  });

  test('skips are durable; no-ID and summary inputs do not invent completion IDs', () => {
    const db = new Database(':memory:');
    try {
      completeObservationBatch(db, 's', [{type:'observation',toolUseId:'a'}, {type:'summarize',toolUseId:'z'}, {type:'observation'}], 'skipped', () => {});
      const ledger = new RecoveryLedger(db);
      expect(ledger.has('s', 'a')).toBe(true); expect(ledger.has('s', 'z')).toBe(false);
      expect(db.query('SELECT outcome FROM observation_receipts').get()).toEqual({outcome:'skipped'});
    } finally { db.close(); }
  });

  test('restart scan reconstructs pairs and leaves earlier unfinished holes despite later completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-transcript-'));
    const file = join(dir,'rollout.jsonl'); const db = new Database(':memory:');
    try {
      writeFileSync(file, [
        {type:'session_meta',payload:{id:'s',cwd:'/repo'}},
        {type:'response_item',payload:{type:'function_call',call_id:'a',name:'read',arguments:'{"path":"中文"}'}},
        {type:'response_item',payload:{type:'custom_tool_call',call_id:'b',name:'patch',input:'patch text'}},
        {type:'response_item',timestamp:'2026-09-08',payload:{type:'custom_tool_call_output',call_id:'b',output:'ok'}},
        {type:'response_item',timestamp:'2026-09-08',payload:{type:'function_call_output',call_id:'a',output:'data'}},
      ].map(x=>JSON.stringify(x)).join('\n')+'\n');
      new RecoveryLedger(db).commit('s',['b'],'stored',()=>{});
      const remaining = [];
      for await(const e of readCodexEvents(file)) if(!isCompleted(db,e)) remaining.push(e);
      expect(remaining).toHaveLength(1); expect(remaining[0].toolUseId).toBe('a');
      expect(remaining[0].toolInput).toEqual({path:'中文'});
    } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
  });

  test('malformed tail and unpaired results fail closed', async () => {
    const dir=mkdtempSync(join(tmpdir(),'mem-bad-')); const file=join(dir,'bad.jsonl');
    try {
      for(const content of ['{"type":', JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'missing'}})]) {
        writeFileSync(file,content);
        await expect((async()=>{for await(const _ of readCodexEvents(file)) {}})()).rejects.toThrow();
      }
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});


describe('bounded recovery submission', () => {
  test('restart repeats only unconfirmed records and never advances on HTTP acceptance alone', async () => {
    const db = new Database(':memory:');
    const event = (id: string) => ({contentSessionId:'s',toolUseId:id,toolName:'read',toolInput:{},toolResponse:'ok',cwd:'/repo',platformSource:'codex' as const,timestamp:'2026-09-08'});
    const events = async function*(){ yield event('a'); yield event('b'); yield event('b'); };
    try {
      const ledger = new RecoveryLedger(db);
      ledger.commit('s',['a'],'stored',()=>{});
      const submit = mock(async()=>{});
      const options = {completed:(e:any)=>isCompleted(db,e),select:()=>true,submit,waitForCompletion:async()=>false,limit:10};
      await expect(replayUncompleted(events(),options)).rejects.toThrow('without durable completion');
      expect(submit).toHaveBeenCalledTimes(1);
      expect(ledger.has('s','b')).toBe(false);
      const retry = await replayUncompleted(events(),{...options,waitForCompletion:async(e)=>{ledger.commit('s',[e.toolUseId],'stored',()=>{});return true;}});
      expect(retry).toEqual({submitted:1,completed:1});
      expect(await replayUncompleted(events(),options)).toEqual({submitted:0,completed:0});
    } finally {db.close();}
  });
});

import { spawnSync } from 'node:child_process';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';

describe('Codex hook recovery identity', () => {
  test('preserves explicit tool ID or call ID without inventing IDs for legacy input', () => {
    const base={session_id:'s',cwd:'/repo',hook_event_name:'PostToolUse',tool_name:'Read'};
    expect(codexAdapter.normalizeInput({...base,tool_use_id:'tool-a',call_id:'call-b'}).toolUseId).toBe('tool-a');
    expect(codexAdapter.normalizeInput({...base,call_id:'call-b'}).toolUseId).toBe('call-b');
    expect(codexAdapter.normalizeInput(base).toolUseId).toBeUndefined();
  });

  test('passes the original ID through actual adapter and observation handler to worker HTTP', () => {
    // Separate process avoids process-global mock.module contamination.
    const result=spawnSync(process.execPath,['-e',`
      import {mock} from 'bun:test';
      const root=process.cwd();
      let sent;
      mock.module(root+'/src/services/hooks/server-client.ts',()=>({isServerClientError:()=>false}));
      mock.module(root+'/src/shared/worker-utils.ts',()=>({
        executeWithWorkerFallback:async(route,method,body)=>{sent={route,method,body};return {};},
        isWorkerFallback:()=>false,
      }));
      mock.module(root+'/src/shared/should-track-project.ts',()=>({shouldTrackProject:()=>true}));
      mock.module(root+'/src/services/hooks/runtime-selector.ts',()=>({resolveRuntimeContext:()=>({runtime:'worker'}),logServerFallback:()=>{}}));
      const {codexAdapter}=await import(root+'/src/cli/adapters/codex.ts');
      const {observationHandler}=await import(root+'/src/cli/handlers/observation.ts');
      const input=codexAdapter.normalizeInput({session_id:'s',cwd:'/repo',tool_name:'Read',tool_input:{path:'test'},tool_response:'ok',tool_use_id:'original-call'});
      await observationHandler.execute({...input,platform:'codex'});
      if(sent?.route!=='/api/sessions/observations'||sent?.body?.tool_use_id!=='original-call'||sent?.body?.contentSessionId!=='s')throw new Error('Hook lost identity');
    `],{cwd:process.cwd(),encoding:'utf8',timeout:20000});
    expect({status:result.status,error:result.stderr}).toEqual({status:0,error:result.stderr});
  });
});
