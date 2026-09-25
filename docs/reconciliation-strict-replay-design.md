# Claude observer: one-shot strict replay design

Status: design only. No manual model retry is enabled. Pending a product
clarification, the conservative interim ceiling is three real model HTTP
dispatches for the entire business task. This may stop a legitimate task that
needs more than three different internal SDK steps; that tradeoff requires an
explicit product decision before release.

## Existing boundaries

* `ObserverTaskStore` persists a task UUID and cleaned source, but
  `SessionMessageBuffer` holds the executable queue only in RAM. A restart
  loses its message ID and enqueue timestamp.
* `ClaudeProvider.startSession()` gives an async prompt generator to Agent SDK
  `query()`. The SDK may make multiple Anthropic HTTP calls for one user turn.
  It emits `api_retry` only after a request failed; no typed pre-request step
  identity or max-retries option is exposed by the SDK `Options` used here.
* `ClaudeProvider.createMessageGenerator()` sends an init/continuation prompt
  before the observation and may call `compressField()` through a separate
  model query. The observation prompt includes `[[cm-task:<task UUID>]]`, but
  the compression query does not.
* The local forwarder identifies an internal model request with SHA-256 of
  its complete rewritten HTTP body. It uses `cmop-<body SHA>` as the default
  idempotency key when the task marker is present. A rebuilt SDK turn can
  change its body and step digest; an exact rebuilt body reuses the old key
  and therefore replays the old gateway outcome instead of making a new call.

These facts make `reserveManualRetry()` plus `queueObservation()` unsafe:
they neither isolate the requested step nor guarantee that one manual action
causes at most one new provider HTTP dispatch.

The current worker has a task-wide three-call check in
`ObserverTaskStore.applyVerifiedCallCount()` and `reserveManualRetry()`, but
the former has no runtime caller and the latter is unreachable because the
mailbox rejects retry commands. A normal Agent SDK turn can therefore make
more than three distinct HTTP requests. The interim ceiling needs an atomic
gateway/forwarder gate **before** the fourth transport start, keyed by
authenticated caller, business key and durable task UUID. Every UUID in a
multi-task request must pass the ceiling; one over-cap task rejects the whole
request at preflight. This counts only durable `http_request_started_at`
witnesses, not provider admission or status queries.

## Durable records required before enabling retry

Worker SQLite, in the same database as `observer_tasks`:

* `observer_replay_commands(command_id UUID PRIMARY KEY, task_id UUID,
  target_step_id SHA256, expected_task_version, state,
  permit_id UUID, created_at, updated_at)`; `command_id` is the mailbox
  idempotency key. State changes use CAS and survive a worker restart.
* `observer_replay_source(task_id PRIMARY KEY, source_payload,
  original_occurred_at_epoch, prepared_observation_prompt,
  prepared_prompt_digest, model_id, mode_version)`; this must be captured
  before the first SDK yield. Current `observer_tasks.payload` lacks the
  exact RAM enqueue timestamp and prepared prompt.
* `observer_replay_step(task_id, model_step_id, request_digest,
  original_idempotency_key, gateway_identity, ordinal, gateway_phase,
  http_request_started_at, http_request_deadline_at, response_cache_state)`.
  The gateway/forwarder own the actual HTTP witness and cache state; the
  worker stores only the identifiers needed for CAS and display.

Forwarder durable store, scoped by authenticated caller and business key:

* `replay_permit(permit_id UUID PRIMARY KEY, command_id UUID UNIQUE,
  task_id UUID, target_step_id SHA256, expected_request_digest SHA256,
  fresh_idempotency_key, state, lease_epoch, created_at)`.
* `replay_allowlist(permit_id, ordinal, request_digest, original_key,
  mode=replay_cached|fresh_target)` for **every** request the SDK may issue
  before reaching the target. The forwarder must fsync this before the worker
  enters the original queue. A forwarder restart reloads the permit and
  cannot issue a second fresh key for the same `command_id`.

The gateway remains the authority for whether an HTTP request started, its
deadline, current in-flight state, and whether an old response is replayable.
An unknown or expired cache entry cannot be treated as a safe prior result.

## One manual action protocol

1. Dashboard creates one mailbox `retry` command with
   `{command_id,task_id,model_step_id,expected_version}`. Worker first checks
   a persisted business outcome, gateway task attempts, current in-flight
   status and the interim task-wide call ceiling. Any unknown evidence fails closed.
2. Worker CAS-reserves the command in SQLite and requests a forwarder replay
   permit through an authenticated loopback route. The permit binds the
   command, task UUID, target digest, exact expected body digest, one fresh
   idempotency key and the ordered prior-step allowlist. Forwarder persists it
   before acknowledging.
3. Worker reconstructs only the selected task from the durable source and
   enters the existing `SessionManager`/`ClaudeProvider` path. The session
   lock permits this reserved task while continuing to hold other unresolved
   tasks. A duplicate mailbox delivery returns the stored command result and
   never enqueues a second message.
4. For each SDK HTTP request with the task marker, forwarder verifies the
   permit and complete body digest **before** opening any upstream socket.
   A known prefix request uses its original idempotency key and must return
   an already cached successful response. An unexpected body, missing cache,
   reordered step, second task marker or missing task marker is rejected at
   preflight with zero provider calls; the business task stays held.
5. Only the exact target body digest receives the permit's fresh key. Every
   SDK internal retry of that same body receives that **same** key, so a
   redelivery cannot add a provider dispatch. The gateway's own durable
   identity and transport-start witness enforce at most one newly admitted
   request for that permit. A changed target body fails preflight.
6. After the target response, subsequent SDK requests remain behind a new
   step gate. They need distinct persisted step identities and admission
   decisions; an unrestricted release would bypass the chosen call ceiling.
   Business success is reported only after the observation/summary write and
   task receipt commit in one SQLite transaction. Timeout/error records one
   failed step, then returns to reconciliation without automatic requeue.

## Required evidence and rejection cases

* `phase=completed` proves a gateway model response, not business success.
  Reconcile against the worker's persisted observation/summary receipt.
* `http_request_started_at=null` does not count as a proven HTTP call.
  `provider_admitted=true` only proves gateway preflight admission.
* A non-null transport-start witness, expired `http_request_deadline_at`,
  `in_flight=false`, and no completed gateway model result proves one failed
  model HTTP request. A still-in-flight request blocks replay even past its
  deadline until the gateway says it is no longer in flight.
  A terminal `phase=failed` with transport-start and `in_flight=false` can be
  counted immediately; `admitted` and `unknown` require deadline expiry.
* A changed request body cannot use the old key (gateway returns digest
  conflict) or a fresh key (unbounded extra call). Reject before the gateway.
* A cached prior step with missing/unknown gateway response cannot be
  recomputed as part of this one-step retry. Keep the task for operator work.

## SDK automatic retry audit

The installed `@anthropic-ai/claude-agent-sdk` type declares
`SDKAPIRetryMessage` with `attempt`, `max_retries`, and `retry_delay_ms`;
its first-byte no-response path says it normally gets one additional retry.
The worker's hardened SDK options provide no documented `maxRetries` field,
and `ClaudeProvider` currently ignores `api_retry` messages. The separate
`withRetry()` helper is used by Gemini/OpenRouter, not this Claude SDK path.
The main observer `query()` has no `maxTurns` setting; only standalone field
compression uses `maxTurns:1`, and that compression request has no task marker.
Therefore one manual `query()` can emit more than one HTTP request. `SessionMessageBuffer`
retry controls do not constrain retries *inside* the SDK subprocess. An
observable `api_retry` event is too late to enforce a pre-send ceiling.

The forwarder/gateway permit must be the hard gate. Its fresh target key is
fixed for the one command, and it must reject any extra target request after
the first actual HTTP dispatch unless it is an idempotent replay of that key.
Before that exists, the mailbox retry path remains `retry_identity_unproven`.
