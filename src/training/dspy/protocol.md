# DSPy host protocol v2

Run `paideia-dspy` from the bridge virtual environment. One process handles one
optimization. Send one finite UTF-8 JSON object per line, terminated by LF, maximum
4 MiB per frame. Duplicate keys, unknown fields and invalid IDs fail closed.
Stdout contains protocol messages only; DSPy diagnostics use stderr.

The host owns input resolution, grouped splits, sealed tests, candidate policy,
native isolated trials, scoring, subscription routes, capture, cancellation and
the total experiment deadline. The bridge receives no datasets, credentials or
sealed-test cases. It never opens a resource path or invokes a native tool loop.
Only allowlisted editable text components belong in `components`; locked text stays
with the host. The host must check every callback candidate before running it.

## Start: host → bridge

```json
{"schema":"paideia.dspy.v2","kind":"optimize","id":"experiment-1","components":{"AGENTS.md":"Agent instructions\n","skills/report/SKILL.md":"# Report\n"},"trainCaseIds":["train-1"],"validationCaseIds":["validation-1"],"budget":{"maxMetricCalls":10,"maxProposals":2},"seed":7}
```

`concurrency` is an optional integer from 1 through 8 (wire default 1). Training
resolves the run setting to 4 with provisioned slots, or legacy 1 without slots.
GEPA uses this value as `num_threads`. The host bounds concurrent delivery and
preserves ordered observation handling within each trial. Writes are atomic JSONL
lines; errors/disconnect fail every waiter. Cancellation drains cooperative work;
unsettled work is reported incomplete and its resources are retained.

Callback IDs emitted by the bridge are SHA-256 over canonical `[method, params]`
plus a per-request occurrence ordinal. The paired checkpoint saves those ordinals,
so replay does not depend on completion order. This replaces v1 sequential IDs;
v1 optimizer checkpoints require their original bridge.

Components are a nonempty map of resource IDs to complete text (maximum 64).
Resource IDs are opaque to Python; TypeScript owns native path mapping. Train and
validation IDs must be nonempty, unique, disjoint lists. No test role exists.
The optional seed (default 0) controls GEPA sampling only, never a subscription
model's generation seed. Both budget fields are required positive integers.

`maxMetricCalls` caps actual native evaluation callback attempts, including failed
attempts; asking again for feedback from a captured result spends no new attempt.
GEPA may reevaluate the same candidate/case; each callback requests a fresh trial.
`maxProposals` caps actual reflection generation callback attempts. One proposal
can replace all editable components together. No internal API retry is permitted.

The complete baseline validation must fit the budget. Before each later iteration,
the bridge reserves one training baseline, one proposed-candidate training trial,
and one complete validation pass. It can finish below the cap. A result with zero
proposals means baseline-only selection, not demonstrated optimization.

## Trial: bridge → host

```json
{"schema":"paideia.dspy.v2","kind":"request","id":"call-1","method":"evaluate","params":{"caseId":"train-1","split":"train","components":{"AGENTS.md":"Agent instructions\n","skills/report/SKILL.md":"# Report\n"}}}
```

```json
{"schema":"paideia.dspy.v2","kind":"response","id":"call-1","result":{"score":0.5,"feedback":"The filing lacked evidence.","output":"Observed native output","captureId":"capture-1"}}
```

Evaluation params may include `round`, a nonnegative integer. The current bridge
always records seed round zero, then GEPA's upstream iteration-start ID or the
population's declared round. The host persists attribution with the native report;
round is part of callback identity. Legacy callbacks may omit it and remain
unattributed. Interrupted checkpoints made before round attribution require their
original bridge; adding params changes content-based callback IDs.

All four result fields are required. `score` is a finite number in [0,1]; the host
owns how gates, unknown/error states and coverage affect that scalar. Infrastructure
failure must use an error response, never a fabricated subject score. `captureId`
identifies an authentic host capture. Missing evidence is not successful evidence.

For `split:"validation"`, both `feedback` and `output` **must be empty strings**.
Validation supplies a selection scalar and capture reference only. Training outputs
and feedback reach reflection. Repeated predictor traces refer to one whole-bundle
native trial; they do not establish per-file causal attribution or observed loading.

## Reflection: bridge → host

```json
{"schema":"paideia.dspy.v2","kind":"request","id":"call-2","method":"generate","params":{"purpose":"reflection","messages":[{"role":"system","content":"..."},{"role":"user","content":"..."}],"options":{}}}
```

```json
{"schema":"paideia.dspy.v2","kind":"response","id":"call-2","result":{"text":"{\"AGENTS.md\":\"Revised instructions\\n\",\"skills/report/SKILL.md\":\"# Revised skill\\n\"}","model":"observed-subscription-model","usage":null}}
```

The host uses its explicitly selected subscription inference adapter and the exact
messages. No paid API fallback, native tools, hidden judge, teacher or DSPy default
model route exists. `options` may contain `responseSchema`, an object JSON Schema.
The public component proposer derives required string properties from exactly the
selected resource paths and forbids extra properties. The host forwards that schema
to its selected provider and validates the completed JSON itself; unsupported
schemas fail before generation. Sampling controls, nontext parts and tool use remain
unsupported. An omitted schema retains plain-text compatibility.

Return the generation's reported model and reported usage (or `null` when unavailable).
If the inference provider supplied only a requested model fallback, include
`modelBasis: "requested-assumption"`. `"provider-reported"` is the explicit observed
alternative; omission retains the existing provider-reported contract. Preserve
this field in final generation provenance. Requested fallbacks are never evidence
for actual-model pricing, even when their string matches the rate catalog.
The bridge retains these without inventing token totals or price estimates. Success
means completed text generation; auth, quota, cancellation and unsupported controls
must be errors. The reflection prompt asks for a JSON map replacing exactly the
selected resource IDs. A malformed response aborts; it is not silently retried.

## Errors and process completion

```json
{"schema":"paideia.dspy.v2","kind":"response","id":"call-2","error":{"code":"quota_exhausted","message":"Subscription quota exhausted"}}
```

Exactly one `result` or `error` is allowed, with the pending callback ID. One
reader dispatches replies by ID; up to `concurrency` callbacks may be outstanding. EOF, malformed replies and host errors are latched;
DSPy's internal score/proposal error handling cannot convert them into success.

The bridge terminates with exit 0 and a `kind:"result"` envelope containing the
original request `id`, selected `components`, and `provenance`:

- `optimizer:"dspy.GEPA"`, `dspyVersion:"3.3.1"`, `gepaVersion:"0.1.4"`, `seed`.
- `evaluations`, `proposals`, `selectedCandidateIndex`.
- `candidates`: full decoded component maps, parent indices, `validationScore`,
  and GEPA's `discoveryEvaluations` accounting (distinct from host attempt count).
- `captures`: `{caseId,split,captureId}` for completed host evaluations.
- `generations`: `{model,usage,modelBasis?}` for completed host reflection generations.

Failure emits `kind:"error"`, `error:{code,message}`, and exits 1. A rejected start
has `id:"unknown"`. Neither a process start nor exit 0 alone is acceptance: the host
must validate the nonempty terminal result, complete component set, bounds and
provenance. The host applies final candidate policy, freezes the selected candidate,
and independently owns any sealed-test comparison or local candidate export.

The host owns timeout/cancellation: terminate this process and cancel its outstanding
callback work together. Killing Python alone does not stop a native trial owned by
the TypeScript host. An optional `checkpoint:{directory,identity}` selects caller-protected durable
state. The caller owns exclusive access. The host journal records exact callback
reservations/results; the Python bridge pairs released GEPA state with session and
sampler state. On resume, host-derived `recovery:{evaluations,proposals}` accounts for
prior failed or uncertain attempts without inventing completed captures. These
offsets reduce remaining budget; they are not candidate feedback. No arbitrary
agent-produced checkpoint or pickle is accepted.

Seed validation is reused on restore, because released GEPA calls it before loading
state. Completed callbacks after the last checkpoint are replayed by exact original
callback identity. Model/criteria/environment drift rejects resume before native work.
The TypeScript training owner separately persists frozen selection and sealed-test
reports; sealed test data never enters this bridge.

## Explicit checkpoint fork

An authorized host may start a **new** experiment from a trusted paired checkpoint:

```json
{"checkpoint":{"directory":"/child/checkpoint/dspy","identity":"new-execution","fork":{"directory":"/parent/checkpoint/dspy","identity":"original-execution","id":"original-experiment","digest":"sha256:<64 lowercase hex characters>"}}}
```

`fork.digest` binds the exact parent `optimizer.json` bytes. Its envelope digest and
old optimizer identity must also match. The old identity is recomputed from the
current request with only experiment ID and execution identity reverted: components,
case splits, budgets, seed, proposal policy and pinned bridge versions stay exact.
Host-derived recovery offsets remain separately accountable as on ordinary resume.

The bridge copies committed GEPA bytes, session outcomes/history/counters and
sampler/RNG state into a disjoint child directory, then atomically commits the new
identity and parent lineage **before any host callback**. It never writes the
parent. Subsequent child resume requires the same fork descriptor and uses its own
committed state; it does not require the parent directory to remain online. Further
forks retain previous lineage. Forks are explicit authorization to use trusted local
pickle state, not a format for importing untrusted agent artifacts.

Callbacks retain their content-derived IDs and persisted occurrence ordinals. A paired Python checkpoint can
lag the host journal: the host must replay matching completed calls byte-for-byte
and fulfill only the pending work. Historical successful outcomes are not rescored
by this import. The host owns any separately authorized measurement repair and must
preserve cumulative failed-attempt accounting; copying state is not a new budget.

## Released integration seam

The actual `dspy.GEPA.compile` receives ordinary named `dspy.Predict` components,
nonempty separate train/validation examples, whole-program scalar/text feedback,
and the public `instruction_proposer` hook. GEPA owns proposal iteration, acceptance,
validation selection and lineage. Python's hook only packages reflection text.

DSPy 3.3.1 normalizes `Signature.instructions` with `inspect.cleandoc`; each native
text is therefore stored as a single-line JSON envelope and decoded before trials.
This preserves untouched Markdown indentation and final newlines exactly. Normal
Predict execution records authentic host results through a custom `dspy.Adapter`.
The separate reflection model uses `BaseLM.forward_contract = "typed_lm"`.

Checked against the installed releases and their sources:
[DSPy 3.3.1 GEPA](https://github.com/stanfordnlp/dspy/blob/3.3.1/dspy/teleprompt/gepa/gepa.py),
[custom proposal hook](https://dspy.ai/api/optimizers/GEPA/GEPA_Advanced/#custom-instruction-proposers),
[typed BaseLM](https://github.com/stanfordnlp/dspy/blob/3.3.1/dspy/clients/base_lm.py).

## Optional population search

`search` switches only the optimizer search owner; an omitted block retains the
released GEPA path, prompts and checkpoint format. The strict block is:

```json
{"variants":4,"keep":2,"rounds":3,"selection":"pareto","rewriteShare":0.5,"minChange":0.08,"hypothesisSimilarity":0.6,"patience":3,"boundaries":[]}
```

`variants` and `keep` are required integers in 1..1000; `rounds` is a required
positive safe integer, with
`keep <= variants`. Defaults for the remaining fields are `pareto`, `0.5`, `0.08`,
`0.6`, `rounds` (no early patience stop), and `[]`. Boundaries contain at most 50
strings of 1..500 characters. Each string is `preserve ["component"]`,
`require-text ["component", "literal"]`, or `forbid-text ["component", "literal"]`.
Arguments are JSON strings; names must identify editable components. Preserve means
exact equality with the seed; required/forbidden text means case-sensitive substring
presence/absence. All constraints must pass. Invalid declarations/prose fail with
`unsupported_boundaries`; invalid seeds fail with `boundary_violation`, before callbacks.
Violating proposals receive `hard-boundary` rejection before evaluation; bounded repairs
are allowed. The host independently enforces these constraints before native trials
and on final candidates. These gates assert text properties, not semantic compliance.
See docs/population-search.md for the authoring contract. Proposal `max_attempts` still defaults to 2 and
caps realization attempts per slot; each planning and realization call consumes
one `maxProposals` unit. The seed's complete validation **and training** must fit
`maxMetricCalls`; `maxProposals` must be at least `keep + variants`.

Round 0 evaluates the seed on complete validation and training. Each later round
assigns N slots across a deterministically shuffled kept population. Each parent
receives one planning generation listing its slot strategies, then one realization
per hypothesis (plus bounded rejection repairs). The global rewrite slot count is
`ceil(variants * rewriteShare)`. Train feedback is cached by candidate/case; only
training text enters generations. Validation always evaluates every declared case.

Pre-trial gates reject normalized duplicates (including earlier rejected attempts
and zero-distance formatting/reordering copies under the instruction-change metric),
behavioral change below `minChange`, same-round accepted siblings below that floor,
and hypothesis content-token Jaccard similarity >= `hypothesisSimilarity` with an
planning or realization hypothesis from another slot or earlier round.
Repairs exclude their own slot history from hypothesis deduplication. Replacement keys must equal selected editable keys.
Realizations use the existing `components`, `hypothesis`, `expectedImpact` envelope;
the `criterion` IDs in its `expectedImpact` array must equal the plan's
`targetedCriteria`. Each item contains exactly `criterion` and `effect`; the bridge
converts the array to a criterion-to-effect map for internal history. Planning returns
`hypotheses: [{strategy,hypothesis,targetedCriteria,plan}]` in requested slot order.
Both prompts treat component text, outputs and feedback as data.

Instruction change v2 joins soft-wrapped paragraph/list continuations and treats
Setext and ATX headings as unscored labels. It splits lists, rows, sentences and
fenced blocks, strips inline emphasis/link syntax and applies NFKC/case-folding.
Independent rules split alike at periods, semicolons and commas. Leading
conditional/workflow clauses (if/unless/when/before/after/until/once) retain their
comma-delimited actions; otherwise/else/then alternatives attach to the preceding
rule. Identical whole
units match independent of position; repetitions count once per component, in
both the numerator and denominator. Remaining units pair by highest weighted
adjacent-token multiset Jaccard similarity, including start/end boundaries. Each
pair weighs 4 if either token is a directive or numeric, otherwise 1. This detects
directive/action reversals even within a clause. History uses zero distance under
this same metric regardless of the configured floor. Unpaired units cost 1;
paired units cost 1 minus similarity. Divide by
the maximum total unit count and clamp to [0,1]. This is a deterministic heuristic,
not proof of semantic change. Lexical trigram distance is reported separately.

Pareto retention uses complete per-case score vectors. Rank the nondominated front
by mean, breaking ties by stable candidate index; fill remaining capacity from the
rest by the same ordering. `top-k` ranks the whole pool by mean. Retain at most K;
the seed may drop. The result selects the best mean among all measured candidates,
with stable index ties. It reports `optimizer:"paideia.population"`, the existing
counters/captures/generations, candidate `perCaseScores`, and `rounds` including
round 0. Each round records parents, all variant slots and kept indexes; every slot
records strategy, hypothesis, targeted criteria, behavioral/lexical change, status,
rejection reason, candidate index (or null), and individual realization attempts.
`stopReason` is `rounds`, `budget` or `patience`. Unfunded slots remain empty.
Population generations include the exact response `text` (legacy generations
remain unchanged); the host checks these bytes against its recorded responses.
`changeEvidence: "bridge-reported-v2"` labels behavioral and lexical values as
bridge-reported heuristics. The host does not recompute or certify novelty scores,
threshold compliance, or hypothesis similarity.

Optional `editScope` maps exactly the component keys to `"whole-file"` or a nonempty
array of declared headings. Population provenance echoes its effective value,
defaulting every resource to whole-file. The host retains actual edit-policy
validation and independently verifies full validation captures, per-case scores,
mean scores, lineage, retention, seed training, strategy allocation, attempt/status
consistency and accepted components/hypotheses against ordered realization
responses before accepting a selected result. It checks stop reasons against round
count, observed stagnation and remaining budget. For a budget stop before a round
starts, the unrecorded shuffled parent is unknown to the host: at least one retained
parent must be unfundable including uncached training. This is feasibility checking,
not independent replay of Python RNG or certification of novelty gates.

`Evaluator.evaluate_many(requests)` returns results in **request order**. The
session-backed thread pool bounds active training and validation callbacks by
`concurrency` (default 1). Completion timing does not change case-score binding
or candidate selection; the host owns leased native trial slots.

Population state is reconstructed from the request, seed and ordered callback
responses. The protected TypeScript journal replays settled callbacks without new
spend; Python creates no checkpoint or pickle. A settled callback interrupted before
receipt is safe to replay. A pending/failed callback produces recovery offsets that
can change earlier budget decisions: population rejects such recovery before any
callback with `unsupported_checkpoint`. Population checkpoint forks also fail closed.
Legacy paired GEPA checkpoint behavior and absent-field identity bytes are retained.

Instruction-change parsing excludes HTML comments, closed leading YAML front matter
and single-line reference definitions before segmentation; fenced content remains scored.
