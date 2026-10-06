# Durable observer batches

Enable with `CLAUDE_MEM_LLM_QUEUE_URL` (HTTPS origin, or loopback HTTP)
and `CLAUDE_MEM_LLM_QUEUE_TOKEN_FILE` (the caller token, never a provider key).
Default business limits: at most 20 inputs and 64,000 serialized request bytes
per batch. `CLAUDE_MEM_LLM_BATCH_ITEMS` permits 1–20, and
`CLAUDE_MEM_LLM_BATCH_BYTES` permits 4,096–256,000.

The cleaned ingress source and its queue ownership are committed together in
SQLite. The producer freezes a request and its task membership before submitting
to the model gateway. A batch has one fresh user message and bounded business
context, with no previous model conversation. Independent batches from one
source session can be submitted concurrently for gateway scheduling. Summaries
wait for prior observations and read a bounded subset of persisted observations.
Oversized single inputs fail explicitly before a model request; full source is
retained. This path does not silently head/tail-truncate a source to clear work.

The gateway owns provider selection, credentials, rate/quota/concurrency,
paid-call attempts and immutable responses. Producer polling reuses the original
batch ID and byte-for-byte stored body. A model success alone never clears a
business task. Parsed observations, task outcomes and the business receipt commit
atomically. The receipt is retried independently after restart, without a new
model request. Invalid or truncated model output remains available for inspection.

`/api/processing-status` includes durable counts grouped by `gateway` / `legacy`
ownership. RAM queue zero is not interpreted as durable backlog zero.

## Migration boundary

Existing SDK tasks and legacy RAM evidence do not acquire ownership merely
because this feature is enabled. Their prior provider admission may be unknown.
They remain visible for reconciliation; never stop the legacy RAM-only process
or import a transcript as proof of unprocessed tasks. A release is not considered
fully migrated until exact legacy evidence is reconciled and the old pending
count has been independently verified. Preserve both database and gateway queue
state across rollback; never re-send queue-owned inputs through the SDK path.
