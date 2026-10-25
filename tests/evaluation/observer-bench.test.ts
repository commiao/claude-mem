import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const python = Bun.which('python3') || Bun.which('python');
(python ? test : test.skip)('observer model benchmark offline contracts (Python + real Bun parser)', () => {
  const result = Bun.spawnSync([python!, '-m', 'unittest', 'discover', '-s', 'tests/evaluation', '-p', 'test_*.py', '-v'], {
    cwd: resolve(import.meta.dir, '../..'),
    env: {...process.env, BUN: process.execPath},
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(result.exitCode).toBe(0);
}, 30_000);
