# Claude observer manual reconciliation

Manual reconciliation is a human-triggered continuation of one durable
observation task. It never schedules an automatic retry. The bridge first
checks the SQLite business receipt and authoritative Gateway attempt evidence.
Only when the task has no result, no live/unknown request, an exact stored
prepared prompt, and an isolated session does it enqueue that one task through
the original `SessionManager` → `SessionRoutes` → `ClaudeProvider` path.

## Worker behavior

* A persisted task receipt is the only business-success signal. A completed
  Gateway response without that receipt is one failed business attempt; the
  provider's billing result does not change that classification.
* The bridge associates attempts only with the exact Gateway `model_step_id`
  and distinct transport-start identities. A pre-deadline request remains
  pending. When the authoritative deadline passes without a usable result, it
  counts once even if Gateway still reports `in_flight`.
* A manual command is durably deduplicated by `command_id`. The worker stores
  `permit_id = command_id`, `Idempotency-Key = cmretry-<command_id>`, the exact
  prepared-prompt digest, and the pre-dispatch call count before queueing.
  Redelivery of a started command only monitors Gateway/local state; it never
  enters the provider queue a second time.
* Replay yields only the exact previously stored observation prompt. It skips
  session-init and field-compression requests, runs through Claude's normal
  response processing, and marks success only when the existing business
  receipt transaction commits. A failed manual replay is removed from the
  in-memory buffer so a later explicit command can isolate it again.
* The isolated replay process sets `CLAUDE_CODE_MAX_RETRIES=0` so the CLI's
  configurable API retry budget is disabled for this manual command only.
  This does not disable every SDK transport retry: some bundled CLI versions
  have a separate first-byte/no-response retry path. That request retains the
  same idempotency key and exact body, so the forwarder/Gateway must coalesce it
  and must not open a second provider request.
* The Gateway start ceiling is three actual starts for the exact logical
  `model_step_id`; normal calls for other steps do not consume this step's
  retry budget. A completed model response without the task's business receipt
  and a deadline-expired no-response call each count as one failed attempt.
  Three witnessed failures make the task terminal `failed`. A consumed
  step-start budget with fewer than three known failures remains in
  reconciliation and cannot be retried by the worker.
* The Gateway claim lease is expected to last 300 seconds. There is no renewal
  loop. Admission must reject an expired command before opening the upstream
  socket; a command that expires before any start returns to reconciliation
  without counting a model call.

## Gateway/forwarder contract

The worker relies on the CredVault integration to enforce the actual HTTP
boundary. The short-lived SDK process receives only
`X-CredVault-Replay-Permit: <command_id>` and
`Idempotency-Key: cmretry-<command_id>`; the worker strips stale replay headers
and requires an HTTP loopback `ANTHROPIC_BASE_URL`. Prompt digests and the old
step hash are not sent as extra headers. The forwarder pins the full new wire
body and key locally, coalesces SDK transport retries with the same key/body,
and rejects body drift. Gateway admission validates the active claimed command,
lease, task, report version, failed-step evidence, and exact-step start budget;
it maps the new wire request to the original logical step from its mailbox.

This worker change does not implement or verify CredVault's forwarder/Gateway
admission code. The end-to-end retry is safe only when that matching integration
is present: an absent/rejected permit must produce no upstream start. There is
no worker-side loop to compensate for that rejection. SDK `maxTurns: 1` caps
the agent turn only. `CLAUDE_CODE_MAX_RETRIES=0` disables the configurable
retry budget, while any SDK-specific no-response retry remains governed by the
forwarder/Gateway idempotency and body-pin checks.

## Operator outcomes

After one manual command the task is one of:

* `succeeded` or valid `skipped`, backed by its persisted business receipt;
* `failed` after the third witnessed failed call; or
* `reconciliation` when evidence is still live/unknown, the 300-second command
  expired before a start, or the worker cannot prove a safe admission. The next
  model attempt, if permitted by the start budget, requires a fresh human
  command.
