import { expect, it } from 'bun:test';
import { join } from 'node:path';

// Both ends must use native Node streams: Bun's child-process wrapper can
// drain a paused stdout into its own buffer, hiding the OS pipe backpressure.
for (const delay of [0, 650]) it(`follows a burst with bounded native reads and byte-exact UTF-8 output (delay=${delay})`, async () => {
  const child = Bun.spawn(['node', join(import.meta.dir, '../fixtures/scripts/worker-follow-backpressure.cjs'), String(delay)], {
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('NATIVE_BACKPRESSURE_OK');
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}, 40000);
