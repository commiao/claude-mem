import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_IO_PATH = join(import.meta.dir, '..', '..', 'src', 'shared', 'hook-io.ts');
const CONTEXT = 'x'.repeat(1024 * 1024) + '\nSynthetic context: \u03bb \ud83d\ude80';
const nodePath = Bun.which('node');
const runtimes = [
  { name: 'Bun', executable: process.execPath },
  ...(nodePath ? [{ name: 'Node', executable: nodePath }] : []),
];
let fixtureDir: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-stdout-'));
  const entrypoint = join(fixtureDir, 'fixture.ts');
  writeFileSync(entrypoint, `
    import { writeSync } from 'node:fs';
    import { emitModelContext, exitGraceful, installHookStderrBuffer } from ${JSON.stringify(HOOK_IO_PATH)};

    const context = ${JSON.stringify(CONTEXT)};
    const adapter = {
      normalizeInput: (input) => input,
      formatOutput: () => process.argv[2] === 'raw'
        ? context
        : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } },
    };
    installHookStderrBuffer();
    process.stderr.write('buffered library noise\\n');

    // Node's old immediate exit prevents this callback from running. The parent
    // then drains on child exit, exposing bytes lost from the pending write.
    // Bun's console.log can block synchronously, so release its reader first.
    if (process.versions.bun) {
      writeSync(3, 'drain');
    } else {
      setImmediate(() => writeSync(3, 'drain'));
    }
    try {
      emitModelContext(adapter, {});
      await exitGraceful();
    } catch (error) {
      writeSync(3, 'failure:' + (error instanceof Error ? error.name : String(error)) + '\\n');
      process.exit(1);
    }
  `);
  const build = await Bun.build({ entrypoints: [entrypoint], target: 'node', format: 'esm' });
  if (!build.success) {
    throw new Error(`Failed to build hook stdout fixture: ${build.logs.join('\n')}`);
  }
  fixturePath = join(fixtureDir, 'fixture.mjs');
  writeFileSync(fixturePath, await build.outputs[0].text());
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

interface CapturedOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  marker: string;
}

async function captureWithPausedReader(
  executable: string,
  kind: 'json' | 'raw',
  closeReader = false,
): Promise<CapturedOutput> {
  if (!nodePath) throw new Error('Native Node pipe fixture requires Node');
  // Native Node owns the extra marker pipe. Bun's child_process compatibility
  // layer can race a fast child exit while connecting fd 3 on macOS.
  const child = Bun.spawn([nodePath, join(import.meta.dir, '../fixtures/scripts/hook-stdout-parent.cjs'),
    executable, fixturePath, kind, String(closeReader)], {stdout: 'pipe', stderr: 'pipe'});
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Native pipe fixture failed: ${stderr}`);
  return JSON.parse(stdout);
}

describe('hook stdout completes before graceful exit', () => {
  for (const runtime of runtimes) {
    it(`${runtime.name} preserves the entire large JSON envelope through a paused pipe`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'json');
      const expected = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
      }) + '\n';

      expect(output.code).toBe(0);
      expect(output.signal).toBeNull();
      expect(output.stderr).toBe('');
      expect(output.stdout.length).toBe(expected.length);
      expect(output.stdout === expected).toBe(true);
      expect(output.stdout.endsWith('\n')).toBe(true);
      expect(JSON.parse(output.stdout).hookSpecificOutput.additionalContext === CONTEXT).toBe(true);
    }, 10000);

    it(`${runtime.name} preserves the entire large raw adapter string and trailing newline`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'raw');
      const expected = CONTEXT + '\n';

      expect(output.code).toBe(0);
      expect(output.signal).toBeNull();
      expect(output.stderr).toBe('');
      expect(output.stdout.length).toBe(expected.length);
      expect(output.stdout === expected).toBe(true);
      expect(output.stdout.endsWith('\n')).toBe(true);
    }, 10000);

    it(`${runtime.name} rejects a closed stdout pipe with a handled delivery error`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'json', true);

      expect(output.code).toBe(1);
      expect(output.signal).toBeNull();
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe('');
      expect(output.marker).toContain('failure:HookStdoutError\n');
    }, 10000);
  }
});
