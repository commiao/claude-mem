import { expect, it } from 'bun:test';
import { exceedsObservationRequestBudget, observationRequestSize } from '../../src/shared/observer-request-budget.js';
it('rejects escaped content that fits as raw text but not as a wire message', () => {
  const value = '\\'.repeat(210000);
  expect(value.length).toBeLessThan(400000);
  expect(exceedsObservationRequestBudget([], value, 400000)).toBe(true);
});
it('checks UTF-8 bytes separately from the gateway character limit', () => {
  const value = '汉'.repeat(350000);
  expect(observationRequestSize([], value).chars).toBeLessThan(400000);
  expect(exceedsObservationRequestBudget([], value, 400000)).toBe(true);
});
it('reserves room for SDK framing and includes every prior turn', () => {
  expect(exceedsObservationRequestBudget([], 'x'.repeat(1000), 400000)).toBe(false);
  expect(exceedsObservationRequestBudget([{role:'assistant',content:'x'.repeat(300000)}], 'y'.repeat(90000), 400000)).toBe(true);
});
