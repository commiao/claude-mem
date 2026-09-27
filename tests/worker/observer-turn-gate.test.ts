import { describe, it, expect } from 'bun:test';
import { ObserverTurnGate } from '../../src/services/worker/session/ObserverTurnGate.js';

describe('ObserverTurnGate', () => {
  it('handles completion before the generator resumes without a lost wakeup', async () => {
    const signal = new AbortController();
    const gate = new ObserverTurnGate(signal.signal);
    for (let i = 0; i < 100; i++) {
      gate.begin();
      gate.complete();
      expect(await gate.wait()).toBe(true);
    }
    gate.dispose();
  });
  it('unblocks on abort and refuses further input', async () => {
    const signal = new AbortController();
    const gate = new ObserverTurnGate(signal.signal);
    gate.begin();
    const waiting = gate.wait();
    signal.abort();
    expect(await waiting).toBe(false);
    gate.begin();
    expect(await gate.wait()).toBe(false);
    gate.dispose();
  });
  it('releases a waiting iterator on SDK shutdown', async () => {
    const gate = new ObserverTurnGate(new AbortController().signal);
    gate.begin();
    const waiting = gate.wait();
    gate.dispose();
    expect(await waiting).toBe(false);
  });
});
