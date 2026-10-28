# Filter metrics in shared score and report

Requires `llm-eval>=0.1.2` and `claude-mem-eval>=0.1.2` in one pinned release
composition. The optional SDK hook is `summarize_score(plan, scored,
annotations=None)`. The core does not import this business package or read a
database. It passes copies to the hook, stores its summary in
`adapter_summary`, and presents its named metrics in HTML and `metrics.csv`.
Older external/KG adapters without the hook retain the existing behavior.

```text
llm-eval score --scenario claude_mem.observation --run RUN --out score-unlabelled.json
llm-eval score --scenario claude_mem.observation --run RUN --annotations review.json --out score-reviewed.json
llm-eval report --scenario claude_mem.observation --run RUN --annotations review.json --out report-reviewed
```

There is no implicit sidecar discovery. An annotated score/report snapshots the
explicit document and its digest in `annotation_evidence`. Exclusive artifact
publication does not replace an earlier score or report. New annotations do not
modify the plan, responses, runtime, or an older report; that report keeps its
own annotation snapshot. Existing `review-*` and `admission` still require their
own independent review evidence; these labels do not sign production admission.

## Explicit review document

The unlabelled score contains `adapter_summary.review_targets.cases` and
`.outputs`, including all hash fields required below. Copy the target bindings
exactly. `output_index` is zero-based within one parsed request's normalized
`observations` array, not a source-record index or database ID.

This is a structural example; `HASH` and the quotes must be replaced with actual
bound hashes and exact source/output excerpts before use:

```json
{
  "schema_version": 1,
  "type": "claude-mem-filter-review",
  "plan_sha256": "HASH",
  "reviewer": {"name": "named reviewer", "method": "human"},
  "cases": [{
    "case_id": "synthetic-case",
    "source_sha256": "HASH",
    "input_value": "valuable",
    "source_quote": "exact source excerpt",
    "rationale": "why this input contains a durable signal"
  }],
  "outputs": [{
    "case_id": "synthetic-case",
    "source_sha256": "HASH",
    "job_id": "candidate.r1.synthetic-case.p1",
    "output_index": 0,
    "raw_sha256": "HASH",
    "output_sha256": "HASH",
    "value": "valuable",
    "fact_support": "supported",
    "source_quote": "exact source excerpt",
    "output_quote": "exact claim in the raw response",
    "rationale": "source-bound explanation"
  }]
}
```

`source_sha256 = digest(adapter.review_source(case))`, using the common canonical
JSON digest. `raw_sha256` is SHA256 of the exact UTF-8 raw reply text.
`output_sha256` is the canonical digest of that one normalized observation.
The plan/adapter and every source and output hash must match; stale, duplicate,
unbound, or fabricated quote references are rejected. If a document is sealed
with the common `sha256` field, its seal is also checked.

When actual `records` are frozen alongside a captured `request`, independent
review uses those records plus the user prompt and allowed business context;
it excludes `request.system` and the generated request wrapper. Two prompt
variants over the same records therefore share a factual source hash and do
not disclose their prompt version to the reviewer. Historical cases containing
only a captured request retain that request as the review-source fallback.
The complete request still binds the sealed dataset, plan, and native call.
Character-ratio measurement separately preserves the original
`mem-unvalidated-2` source-field serialization, including captured request;
anonymous review does not silently change the character denominator.

Value labels are `valuable`, `low`, `none`, or `unknown`. Fact-support labels are
`supported`, `incorrect`, or `unknown`. Value and factual support are separate
axes: an otherwise useful observation can contain an incorrect claim, and a
factually correct progress update can have no durable value. Missing labels
remain unknown; the adapter never derives them from expected anchors, tool
names, parser validity, or a skip decision. Exact quotes establish binding, not
semantic truth or reviewer identity. Reviewer labels are operator supplied and
do not attest an independent human/model identity.

Input noise interception and useful-input false rejection are conditioned on
explicitly reviewed input values. Output contamination uses output counts.
Coverage and unknown bounds are shown. Missing execution results are excluded
from filter-quality denominators and shown as pending execution coverage;
known invalid/no-content responses are `empty`, not successful skips.
Generated count/conversion and actual new-row count/conversion are separate.
If the frozen source has neither records nor a verified source-task count, the
raw-source-task denominator is unknown, not one by assumption.

## Optional frozen persistence receipt

Fresh A/B generations do not write the memory database. Their actual new-row
counts, insertion conversion, and persisted contamination remain unknown.
Reviewers cannot assert `persisted_ids` in the review document.

For historical **captured requests**, the installed business exporter can
create a separate receipt:

```text
claude-mem-persistence-receipt --run RUN --db /private/path/claude-mem.db --out persistence.json
```

Run this command in the run's pinned installed composition. The exporter calls
no model. It opens SQLite with `mode=ro`, starts one read transaction, and uses
only explicit `case.source.batch_id` lookups. The original frozen request and
evaluated raw reply must match the stored batch. It deduplicates shared task
outcomes, distinguishes `insertedObservationIds` from merged-existing flags, and
reads the actual observation rows back. Normalized row hashes must match the
evaluated observations. Missing/deleted/changed rows or incomplete mappings
leave persistence unknown. Historical receipts require one repetition; they
must not convert multiple model generations into purported database writes.

Put the sealed receipt object under `persistence_receipt` in the explicit review
document (or in an otherwise empty document with the same type/plan binding).
The hook rechecks the seal, plan/adapter, source batch, request, raw/normalized
hashes, original outcomes, and readback rows before displaying actual new-row
metrics. It rejects guessed IDs or existing IDs labelled as insertions. Full
matching readback is required for exact counts; partial evidence is displayed
as unknown with an explicitly verified lower-bound count.

This is local integrity evidence, not a cryptographic assertion that a provider
or human signed it. The receipt records read-only-export provenance; no
database path is ever opened by shared `score/report`.
