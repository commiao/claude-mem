import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { TranscriptWatcher } from '../src/services/transcripts/watcher.js';

const watcherSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'transcripts', 'watcher.ts'),
  'utf-8',
);

describe('Codex transcript ingestion on Windows (#2192)', () => {
  it('normalizes backslashes to forward slashes before passing the path to scanGlob', () => {
    const watcher = Object.create(TranscriptWatcher.prototype) as any;
    expect(watcher.normalizeGlobPattern('nested\\*.jsonl'))
      .toBe(resolve('nested', '*.jsonl').replace(/\\/g, '/'));
    expect(watcherSource).toMatch(/scanGlob\(this\.normalizeGlobPattern\(/);
  });

  it('exposes a public poke() on the file tailer so the recursive root watcher can prod it', () => {
    expect(watcherSource).toMatch(/\bpoke\(\): void\b/);
  });

  it('pokes an existing tailer on root-watcher events instead of returning early', () => {
    expect(watcherSource).toMatch(/existingTailer\.poke\(\)/);
  });

  it('normalizes the resolved path to forward slashes before tailer-map lookup', () => {
    expect(watcherSource).toMatch(/resolvePath\(watchRoot, name\)\.replace\(\/\\\\\/g, '\/'\)/);
  });

});
