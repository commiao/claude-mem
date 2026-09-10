/** One representation shared by compression admission and final prompt rendering. */
export function normalizeToolResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    // Only the known command-result envelope. Never recursively decode values.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        typeof parsed.stdout === 'string' && typeof parsed.stderr === 'string' &&
        (parsed.exit_code === null || Number.isInteger(parsed.exit_code))) return parsed;
  } catch { /* ordinary text */ }
  return value;
}
export function serializeObservationField(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}
export class ObservationPreparationError extends Error {
  constructor(public readonly reason: string) {
    super(`Observation requires explicit recovery: ${reason}`);
    this.name = 'ObservationPreparationError';
  }
}
