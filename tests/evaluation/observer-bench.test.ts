import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const python = process.env.LLM_EVAL_TEST_PYTHON || Bun.which('python3') || Bun.which('python');
const installed = python && Bun.spawnSync([python, '-c', 'import llm_eval, claude_mem_eval'], {stdout:'ignore',stderr:'ignore'}).exitCode === 0;
(installed ? test : test.skip)('observer model benchmark offline contracts (Python + real Bun parser)', () => {
  const result = Bun.spawnSync([python!, '-m', 'unittest', 'discover', '-s', 'tests/evaluation', '-p', 'test_*.py', '-v'], {
    cwd: resolve(import.meta.dir, '../..'),
    env: {...process.env, BUN: process.execPath},
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(result.exitCode).toBe(0);
}, 30_000);
