# Observer semantic and filtering regressions

`docs/examples/observer-semantic-regressions.json` contains five synthetic,
source-grounded cases derived from failure classes found in historical output.
It contains no production records, model scores, or provider credentials.

The cases keep one frozen input and one expected disposition per source:

| Case | Required semantic check |
| --- | --- |
| Metric name preservation | Keep accepted, mismerge, and error counts distinct. Batch suffixes do not establish a model version change or quality trend. |
| Visible rows vs population | A tail of three batches supports those rows and the queue marker. It does not establish the full population or answer correctness. |
| Operation-stage attribution | Bind call counts and outcomes to registration, local precheck, and provider probe separately; preserve unknown billing and unverified usability. |
| Routine claim metadata | When local progress already belongs to the queue and there is no new result, blocker, configuration change, or reusable finding, skip temporary identifiers and file paths. |
| Existing-memory recapture | Reading earlier observations is not a new event. Skip rewriting their facts unless the event supplies a supported correction, change, contradiction, or new reusable conclusion. |

## Independent review rubric

For each returned observation, quote the source and the actual output claim.
Judge metric name, number, unit, population, time window, operation stage,
ownership, and completed-versus-planned status separately. A statement with an
unsupported scope is not repaired by preserving a nearby correct number.
An assertion may be unsupported without being proven false in the wider world.

For the noise case, judge whether there is an independent durable signal, not
whether a particular tool name appears. A claim operation can expose a new
blocker or bug and be worth recording; the supplied case deliberately contains
only routine queue metadata. New-observation volume and conversion rate must
be reported alongside output low/no-value contamination and input-noise
interception. Never optimize conversion in isolation or count every skip as a
successful filter.

`expected.required_facts` and `expected.forbidden_claims` define review
standards. Their `anchors` are lexical diagnostics only: passing anchors does
not prove semantic correctness, and a forbidden phrase quoted as a warning is
not necessarily an erroneous assertion. Check the complete claim in context.

## Offline preparation

Use the installed shared CLI, with a matching released adapter:

```text
llm-eval freeze --scenario claude_mem.observation --cases docs/examples/observer-semantic-regressions.json --scope synthetic --out /private/eval/semantic-dataset.json
llm-eval plan --scenario claude_mem.observation --dataset /private/eval/semantic-dataset.json --candidates /private/eval/candidates.json --max-calls 0 --out /private/eval/semantic-plan.json
```

Freeze, plan, and adapter validation do not call a model. They validate the
case/request contracts, not model behavior. To test an unreleased prompt
change, first build its bridge/adapter in the isolated development validation
environment and pin that version; the installed released bridge still uses its
own frozen mode resources. Do not report a released-bridge format check as an
evaluation of changed prompt semantics.

Any future model generation or probe needs a separately defined execution
scope and call budget. The prompt's evidence-boundary guidance is an unverified
mitigation until actual outputs have received independent source-bound review.
There is no production admission, automatic route change, historical data
rewrite, or keyword-based semantic acceptance gate in this change.
