import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

// Every worker start re-collected every already-adopted row (5,539 ids on the
// live install) to retry a Chroma patch, even with Chroma turned off, where the
// patch could only fail: an ERROR per repository and a chroma-mcp prewarm on
// every start. Already-adopted rows are re-patched only while a patch is owed.
const chromaCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let chromaFails = false;
const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (name: string, args: Record<string, unknown>) => {
        chromaCalls.push({ name, args });
        if (chromaFails) throw new Error('chroma-mcp prewarm failed');
        if (name === 'chroma_get_documents') {
          const ids = ((args.where as any).$and[1].sqlite_id.$in as number[]);
          return { ids: ids.map(id => `obs_${id}`), metadatas: ids.map(id => ({ sqlite_id: id, doc_type: 'observation' })) };
        }
        return {};
      }
    })
  }
}));

import { adoptMergedWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { logger } from '../../../src/utils/logger.js';

let tempRoot: string | undefined;

afterEach(() => {
  chromaCalls.length = 0;
  chromaFails = false;
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

/** A repository with a merged worktree `feature`, and one observation written there. */
function setup(): { mainRepo: string; dataDirectory: string; addObservation: () => void } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-adopt-retry-'));
  const mainRepo = path.join(tempRoot, 'parent-repo');
  const worktree = path.join(tempRoot, 'feature-wt');
  const dataDirectory = path.join(tempRoot, 'data');
  mkdirSync(mainRepo, { recursive: true });
  mkdirSync(dataDirectory);
  git(mainRepo, 'init', '-b', 'main');
  git(mainRepo, 'config', 'user.email', 'test@example.com');
  git(mainRepo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(mainRepo, 'README.md'), 'base\n');
  git(mainRepo, 'add', 'README.md');
  git(mainRepo, 'commit', '-m', 'base');
  git(mainRepo, 'worktree', 'add', '-b', 'feature', worktree);

  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  let n = 0;
  const addObservation = () => {
    const store = new SessionStore(dbPath);
    const sessionId = store.createSDKSession(`content-${n}`, 'parent-repo/feature-wt', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, `memory-${n}`);
    store.storeObservation(`memory-${n}`, 'parent-repo/feature-wt', {
      type: 'discovery', title: `obs ${n}`, subtitle: null, facts: [], narrative: 'n',
      concepts: [], files_read: [], files_modified: []
    } as any, 1, 0);
    n++;
    store.close();
  };
  addObservation();
  return { mainRepo, dataDirectory, addObservation };
}

const patchedIds = () => chromaCalls
  .filter(call => call.name === 'chroma_get_documents')
  .flatMap(call => (call.args.where as any).$and[1].sqlite_id.$in as number[]);

describe('worktree adoption Chroma patch retry', () => {
  it('does not touch Chroma, or report a failure, when Chroma is disabled', async () => {
    const { mainRepo, dataDirectory } = setup();
    const errorSpy = spyOn(logger, 'error');
    try {
      const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: false });
      expect(result.adoptedObservations).toBe(1);
      expect(result.chromaFailed).toBe(0);
      expect(chromaCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('re-patches already-adopted rows only while a patch is owed', async () => {
    const { mainRepo, dataDirectory, addObservation } = setup();

    // First start with Chroma on: the new row is adopted and patched.
    let result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: true });
    expect(result.adoptedObservations).toBe(1);
    expect(patchedIds()).toHaveLength(1);

    // Next start, nothing new: no Chroma round trip at all.
    chromaCalls.length = 0;
    result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: true });
    expect(result.adoptedObservations).toBe(0);
    expect(chromaCalls).toEqual([]);

    // A new row is patched alone, not with the rows patched before.
    addObservation();
    result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: true });
    expect(result.adoptedObservations).toBe(1);
    expect(patchedIds()).toHaveLength(1);
  });

  it('retries a failed patch on the next start, then stops once it lands', async () => {
    const { mainRepo, dataDirectory } = setup();

    chromaFails = true;
    let result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: true });
    expect(result.chromaFailed).toBe(1);

    chromaFails = false;
    chromaCalls.length = 0;
    result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: true });
    expect(result.adoptedObservations).toBe(0);
    expect(result.chromaUpdates).toBe(1);

    chromaCalls.length = 0;
    await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: true });
    expect(chromaCalls).toEqual([]);
  });

  it('owes the patch for rows adopted while Chroma was off, once it is turned on', async () => {
    const { mainRepo, dataDirectory } = setup();
    await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: false });
    expect(chromaCalls).toEqual([]);

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory, chromaEnabled: true });
    expect(result.chromaUpdates).toBe(1);
    expect(patchedIds()).toHaveLength(1);
  });
});
