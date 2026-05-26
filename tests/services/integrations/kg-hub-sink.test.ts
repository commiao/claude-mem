import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

const originalEnv = { ...process.env };
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function importSink() {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return import(`file://${process.cwd()}/src/services/integrations/KgHubSink.ts?test=${cacheBuster}`);
}

describe('KgHubSink', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    fetchCalls = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    mock.restore();
  });

  it('does not call kg-hub when no endpoint is configured', async () => {
    delete process.env.CLAUDE_MEM_KG_HUB_URL;
    delete process.env.KG_HUB_URL;
    const { syncObservationsToKgHub } = await importSink();

    await syncObservationsToKgHub({
      observations: [{
        id: 1047,
        sourceObsId: 'claude-mem-observation-1047',
        sourceDescription: 'claude-mem obs id=1047 project=workspace_cursor type=feature',
        name: 'claude-mem-obs-1047',
        content: 'Cursor capture verified',
        referenceTime: '2026-05-20T05:36:00.000Z',
        contentSessionId: 'cursor-live-verify-20260520133600',
        platformSource: 'cursor',
        project: 'workspace_cursor',
      }],
    });

    expect(fetchCalls).toHaveLength(0);
  });

  it('posts each observation to kg-hub using the async ingest schema', async () => {
    process.env.CLAUDE_MEM_KG_HUB_URL = 'http://127.0.0.1:8080';
    process.env.CLAUDE_MEM_KG_HUB_API_TOKEN = 'test-token';
    process.env.CLAUDE_MEM_KG_HUB_MIN_INTERVAL_MS = '0';
    const { syncObservationsToKgHub } = await importSink();

    await syncObservationsToKgHub({
      observations: [{
        id: 1047,
        sourceObsId: 'claude-mem-observation-1047',
        sourceDescription: 'claude-mem obs id=1047 project=workspace_cursor type=feature',
        name: 'claude-mem-obs-1047',
        content: 'Cursor session cursor-live-verify-20260520133600 produced claude-mem observation 1047',
        referenceTime: '2026-05-20T05:36:00.000Z',
        contentSessionId: 'cursor-live-verify-20260520133600',
        platformSource: 'cursor',
        project: 'workspace_cursor',
      }],
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:8080/api/ingest');
    expect(fetchCalls[0].init?.method).toBe('POST');
    expect(fetchCalls[0].init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    });
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    expect(body).toEqual({
      name: 'claude-mem-obs-1047',
      episode_body: 'Cursor session cursor-live-verify-20260520133600 produced claude-mem observation 1047',
      source_description: 'claude-mem obs id=1047 project=workspace_cursor type=feature',
      source_obs_id: 'claude-mem-observation-1047',
      reference_time: '2026-05-20T05:36:00.000Z',
      sync: false,
    });
  });

  it('serializes concurrent sync calls so kg-hub is not flooded', async () => {
    process.env.CLAUDE_MEM_KG_HUB_URL = 'http://127.0.0.1:8080';
    process.env.CLAUDE_MEM_KG_HUB_MIN_INTERVAL_MS = '0';
    const responders: Array<() => void> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      await new Promise<void>(resolve => responders.push(resolve));
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
    }) as unknown as typeof fetch;

    const { syncObservationsToKgHub } = await importSink();
    const first = syncObservationsToKgHub({
      observations: [{
        id: 1,
        sourceObsId: 'claude-mem-observation-1',
        sourceDescription: 'claude-mem obs id=1 project=p type=discovery',
        name: 'claude-mem-obs-1',
        content: 'first',
        referenceTime: '2026-05-20T05:36:00.000Z',
        contentSessionId: 's1',
        platformSource: 'cursor',
        project: 'p',
      }],
    });
    const second = syncObservationsToKgHub({
      observations: [{
        id: 2,
        sourceObsId: 'claude-mem-observation-2',
        sourceDescription: 'claude-mem obs id=2 project=p type=discovery',
        name: 'claude-mem-obs-2',
        content: 'second',
        referenceTime: '2026-05-20T05:36:00.000Z',
        contentSessionId: 's2',
        platformSource: 'cursor',
        project: 'p',
      }],
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCalls).toHaveLength(1);
    responders.shift()?.();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCalls).toHaveLength(2);
    responders.shift()?.();
    await second;
  });

  it('applies a minimum interval between accepted kg-hub posts', async () => {
    process.env.CLAUDE_MEM_KG_HUB_URL = 'http://127.0.0.1:8080';
    process.env.CLAUDE_MEM_KG_HUB_MIN_INTERVAL_MS = '25';
    const { syncObservationsToKgHub } = await importSink();
    const start = Date.now();

    await syncObservationsToKgHub({
      observations: [
        {
          id: 11,
          sourceObsId: 'claude-mem-observation-11',
          sourceDescription: 'claude-mem obs id=11 project=p type=discovery',
          name: 'claude-mem-obs-11',
          content: 'first',
          referenceTime: '2026-05-20T05:36:00.000Z',
          contentSessionId: 's1',
          platformSource: 'cursor',
          project: 'p',
        },
        {
          id: 12,
          sourceObsId: 'claude-mem-observation-12',
          sourceDescription: 'claude-mem obs id=12 project=p type=discovery',
          name: 'claude-mem-obs-12',
          content: 'second',
          referenceTime: '2026-05-20T05:36:00.000Z',
          contentSessionId: 's1',
          platformSource: 'cursor',
          project: 'p',
        },
      ],
    });

    expect(fetchCalls).toHaveLength(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
