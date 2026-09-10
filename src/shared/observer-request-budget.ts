import type { ConversationMessage } from '../services/worker-types.js';

// Operational envelope allowance, not a chars/token conversion. Verified with
// SDK 0.3.261 + deployed CLI 2.1.126: a tool-free request adds ~1.1k bytes.
// Leave room for framing, system blocks, metadata, and each turn's block shape.
export const OBSERVER_REQUEST_OVERHEAD = 16_384;
export const OBSERVER_MESSAGE_OVERHEAD = 256;
export const OBSERVER_REQUEST_MAX_BYTES = 1_048_576;

export function observationRequestSize(history: ConversationMessage[], incoming: string) {
  const messages = [...history, { role: 'user', content: incoming }];
  const serialized = JSON.stringify(messages);
  const allowance = OBSERVER_REQUEST_OVERHEAD + messages.length * OBSERVER_MESSAGE_OVERHEAD;
  return {
    // JS UTF-16 count is conservative versus the gateway's Unicode codepoints.
    chars: serialized.length + allowance,
    bytes: Buffer.byteLength(serialized, 'utf8') + allowance,
  };
}

export function exceedsObservationRequestBudget(history: ConversationMessage[], incoming: string, maxChars: number): boolean {
  const size = observationRequestSize(history, incoming);
  return size.chars >= maxChars || size.bytes >= OBSERVER_REQUEST_MAX_BYTES;
}
