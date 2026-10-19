import { describe, it, expect } from 'bun:test';
import { classifyClaudeError } from '../../src/services/worker/ClaudeProvider.js';
import { paidSendOutcomeOf } from '../../src/services/worker/provider-errors.js';
import { gatewayDispositionFromText, jobErrorDisposition } from '../../src/services/worker/gateway-disposition.js';
import {
  GATEWAY_PAUSED_RECHECK_COOLDOWN_MS,
  GATEWAY_PAUSED_WINDOW,
  GATEWAY_RETRY_WINDOW,
  RATE_LIMIT_RECHECK_COOLDOWN_MS,
  resolveQuotaCooldownMs,
} from '../../src/shared/quota-cooldown.js';

/** A gateway error as the Anthropic SDK carries it: the body on `.error`. */
function gatewayError(status: number, error: Record<string, unknown>): Error {
  return Object.assign(new Error(`${status} ${JSON.stringify({type:'error',error})}`),
    { status, error: { type: 'error', error } });
}

describe('classifyClaudeError follows the gateway disposition on the direct path', () => {
  it('paused: a 503 for a paused route is a gateway pause, not a transient fault', () => {
    const c = classifyClaudeError(gatewayError(503, {type:'api_error',code:'business_route_disabled',disposition:'paused'}));
    expect(c.kind).toBe('gateway_paused');
    expect(c.gatewayDisposition).toBe('paused');
    expect(c.code).toBe('business_route_disabled');
    expect(paidSendOutcomeOf(c)).toBe('refused_before_work');
  });

  it('retry with same_key: a deferral with its wait, refused before work', () => {
    const c = classifyClaudeError(gatewayError(429, {code:'cost_limit_exceeded',disposition:'retry',same_key:true,retry_after_seconds:30}));
    expect(c.kind).toBe('rate_limit');
    expect(c.retryAfterMs).toBe(30_000);
    expect(c.gatewayDisposition).toBe('retry');
    expect(paidSendOutcomeOf(c)).toBe('refused_before_work');
  });

  it('retry with same_key=false is still a deferral, never reconciliation', () => {
    const c = classifyClaudeError(gatewayError(502, {code:'provider_error',disposition:'retry',same_key:false}));
    expect(c.kind).toBe('rate_limit');
    expect(c.retryAfterMs).toBeUndefined();
    expect(paidSendOutcomeOf(c)).not.toBe('ambiguous');
  });

  it('failed: the same code as a deferral, but terminal', () => {
    const c = classifyClaudeError(gatewayError(429, {code:'cost_limit_exceeded',disposition:'failed'}));
    expect(c.kind).toBe('unrecoverable');
    expect(c.gatewayDisposition).toBe('failed');
    expect(paidSendOutcomeOf(c)).toBe('rejected');
  });

  it('reconciliation: unknown outcome, the only ambiguous one', () => {
    const c = classifyClaudeError(gatewayError(504, {code:'provider_timeout',disposition:'reconciliation'}));
    expect(c.kind).toBe('transient');
    expect(c.gatewayDisposition).toBe('reconciliation');
    expect(paidSendOutcomeOf(c)).toBe('ambiguous');
  });

  it('no disposition keeps the existing classification', () => {
    const c = classifyClaudeError(Object.assign(new Error('Internal server error'), { status: 503 }));
    expect(c.kind).toBe('transient');
    expect(c.gatewayDisposition).toBeUndefined();
  });

  it('reads the disposition the CLI quotes in its message', () => {
    const c = classifyClaudeError(new Error('API Error: 503 {"type":"error","error":{"code":"provider_circuit_open","disposition":"paused"}}'));
    expect(c.kind).toBe('gateway_paused');
  });

  it('reads a string body', () => {
    const c = classifyClaudeError(Object.assign(new Error('refused'), {
      status: 503, body: JSON.stringify({error:{code:'business_route_disabled',disposition:'paused'}}) }));
    expect(c.kind).toBe('gateway_paused');
  });
});

describe('gateway disposition parsing', () => {
  it('reads only a whole-response API error envelope', () => {
    expect(gatewayDispositionFromText('API Error: 503 {"type":"error","error":{"code":"x","disposition":"paused"}}'))
      .toMatchObject({disposition:'paused',code:'x'});
    expect(gatewayDispositionFromText('The observer noted API Error: 503 {"error":{"disposition":"paused"}}')).toBeNull();
    expect(gatewayDispositionFromText('API Error: 503 Service Unavailable')).toBeNull();
    expect(gatewayDispositionFromText('API Error: 503 {"error":{"disposition":"stop"}}')).toBeNull();
  });

  it('a job error without a disposition is reconciliation', () => {
    expect(jobErrorDisposition({code:'internal_error'})).toMatchObject({disposition:'reconciliation',code:'internal_error'});
    expect(jobErrorDisposition(null).disposition).toBe('reconciliation');
    expect(jobErrorDisposition({disposition:'retry',same_key:true,retry_after_seconds:5}))
      .toMatchObject({disposition:'retry',sameKey:true,retryAfterMs:5000});
  });

  it('gateway windows: a pause probes every 5 minutes, a deferral clears like a rate limit', () => {
    expect(resolveQuotaCooldownMs(GATEWAY_PAUSED_WINDOW)).toBe(GATEWAY_PAUSED_RECHECK_COOLDOWN_MS);
    expect(GATEWAY_PAUSED_RECHECK_COOLDOWN_MS).toBe(300_000);
    expect(resolveQuotaCooldownMs(GATEWAY_RETRY_WINDOW)).toBe(RATE_LIMIT_RECHECK_COOLDOWN_MS);
  });
});
