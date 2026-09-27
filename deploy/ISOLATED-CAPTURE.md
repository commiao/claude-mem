# Legacy RAM queue: isolated capture preparation

`prepare_isolated_capture.py` reads the live source through SQLite backup and
creates a new, exclusive destination. It never stops or writes to the source.
The destination keeps observations and historical SDK sessions for search.
Historical content session ids move under `legacy/<generation>/<id>`. Fresh
capture rows keep the original content ids but have no SDK memory id or worker
port, so a new worker cannot resume the old worker's SDK conversations. The
latest user prompt is copied exactly to each fresh row, preserving privacy.

A destination file existing is **not** success. Require the command's successful
exit and its `capture_generation` row. A failed preparation leaves evidence;
never launch that file. Existing foreign-key violations are retained exactly,
not repaired or discarded. Durable observer tasks in the source are rejected:
this procedure only applies to the legacy RAM-only worker.

The reported `baseline_observation_id` must be the new source's `after_id` in
the kg-hub dual-source manifest. Copied observations must not be imported again.
The aggregate DB is durable identity state and must be backed up, never silently
regenerated. Its legacy source retains published observation ids; all subsequent
rows receive globally increasing ids through an atomic source mapping.

## Cutover requirements (not performed by this preparation command)

1. Validate the exact release's full tests; isolate port, PID registry, logs,
   Chroma and settings. Disable transcript rescans/cloud sync on the new runtime.
2. Preserve the legacy PID explicitly in the kg-hub guard's state directory.
   Do not use activeSessions or old pending_messages as proof of safe shutdown.
3. Capture ingress during the handoff and reconcile user prompts accepted after
   the snapshot before releasing observations to the new observer. Snapshot
   privacy inheritance alone does not solve concurrent prompt arrival.
4. Validate both sources through the durable aggregate and existing NAS sync.
   Update the launchd sync job's source path and manifest together.
5. Switch hook routing, artifact selection, launchd and guard configuration as
   one reviewed operation. Validate new-task persistence and actual completion.
6. Rollback must keep new durable queued/in-flight work; switching back cannot
   silently replay it. Legacy RAM remains untouched throughout.

These tools prepare and validate data; they do not themselves authorize or
implement production traffic switching.
