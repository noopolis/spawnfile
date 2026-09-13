# Paideia dataset YAML

**Implemented authoring surface.** The strict YAML parser, fixture resolver, evaluator
registry and native training loop use this schema. Native environment configuration
stays with its owning runtime. Project-specific preparation and custom evaluators
need registered implementations; an example name alone does not install one.

## The authoring unit

One YAML file is one dataset. Its records are inline. An existing Spawnfile and its
environment define the subject; Paideia does not require agent.yaml, runtime.yaml,
experiment.yaml or a separate YAML for every case. Other adapters consume their own
native project configuration without requiring Spawnfile or Daimon.

A training invocation selects the native project, subject, train dataset, test dataset,
editable prompt resources, inference routes and limits. These become a generated
immutable run manifest, not four more mandatory files for the author to maintain.
The public API and local CLI resolve these selections explicitly. See the
[native formatting example](../examples/native-formatting/README.md) for a completed
Codex/Daimon training and held-out comparison.

Keep datasets under `evals/` beside the native project; use `train.paideia.yaml` and
`test.paideia.yaml` for the two datasets when helpful. They have the same
schema. Filenames do not confer access control: the invocation binds the training and
sealed-test roles. A validation partition may be selected by evidence group within
training data; a separate validation file is optional, not a required third dataset.

The `.paideia.yaml` suffix identifies the authoring surface and preserves ordinary YAML
tooling. Content declares `schema: paideia.dataset.v1`; the filename never replaces it.

Spawnfile projects use the agreed `.spawnignore` shape to declare packaging exclusions;
enforcement is not implemented. See [native packaging](harnessing.md#colocated-evaluation-and-packaging).

The [Example Newsroom example](../examples/newsroom-reporting/README.md) uses real Spawnfile
resources and archived packets to exercise the schema. Its newsroom preparation,
filtered repositories, memory parity and direct-research audit are not implemented.

## Smallest dataset

```yaml
schema: paideia.dataset.v1
id: arithmetic
records:
  - id: addition
    input:
      prompt: Reply with only the result of 2 + 2.
    checks:
      - id: correct
        eval: equals
        input: output.text
        value: "4"
```

That is one dataset, one independent task and one exact-text check. Each repetition
starts with fresh state. No implicit trimming, case folding or normalizing occurs.

## Dataset and record fields

| Dataset field | Meaning |
| --- | --- |
| `schema` | Required version discriminator: `paideia.dataset.v1` |
| `id` | Required stable dataset ID |
| `subject` | Optional native subject identity; must match the selected native project |
| `setup` | Optional typed environment recipe and declared emulation parameters |
| `fixtures` | Optional mapping of same-file names to partial record declarations; see [fixtures](fixtures.md) |
| `live` | Optional shared incremental checks and stop policy; see [live evaluation](live-evaluation.md) |
| `checks` or `stages` | Optional shared checks applied to every record; mutually exclusive |
| `records` | Required nonempty sequence of inline task records |

| Record field | Meaning |
| --- | --- |
| `id` | Required ID, unique within the dataset |
| `group` | Evidence-family identity, required for optimization/held-out comparison |
| `use` | Optional sequence of same-file fixture names to expand before record-local values |
| `context` | Typed setup/evaluator parameters, not automatically sent to the subject |
| `setup` | Optional declared parameters of the selected preparation recipe |
| `input` or `turns` | One visible task, or ordered external stimuli within a task; mutually exclusive |
| `reference` | Evaluator-only files or labels; never implicitly subject input |
| `outputs` | Named file artifacts the harness must collect from the isolated workspace |
| `checks` or `stages` | Optional additional record checks; mutually exclusive |

Every record needs visible input and at least one effective check. Dataset checks
always apply; a record may add checks but cannot replace or weaken them by repeating
an ID. Resolve IDs, references, dependencies and effective gates before paid work.
Record setup parameters cannot silently change native tools, permissions or locked
source configuration. Unknown fields, duplicate keys and unsupported requirements fail
resolution; do not drop them and continue.

## Reuse named fixtures

`fixtures` names reusable partial records inside this dataset; record `use` selects
them explicitly. Dataset `setup` remains the shared recipe and defaults. Fixtures can
supply context, setup parameters, inputs, references and outputs, while record identity,
group and checks remain outside them. See [fixture resolution](fixtures.md) for the
canonical merge, conflict, policy and isolation rules. The real datasets use an
`afternoon-assignment` fixture and a named evidence packet for each record.

## Select the actual inputs

```yaml
schema: paideia.dataset.v1
id: newsroom-reporting
subject: scribe
records:
  - id: kestrel-report
    group: kestrel-2026-09-12
    context:
      edition: "2026-09-12"
      article_id: s-1a2b3c4d
    input:
      prompt: Read the commissioned story, report it, validate, file and notify Reviewer.
      files:
        - resource: private-archive
          path: 2026-09-12/stories/s-1a2b3c4d.md
          sha256: sha256:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a
    checks:
      - id: validated
        eval: tool-called
        tool: mcp_validation_validate_article
        outcome: succeeded
```

The hash above and the [actual datasets](../examples/newsroom-reporting/evals/train.paideia.yaml) were
checked against the pinned repository bytes. A missing or wrong hash must fail.
Calling validation is just one observable behavior, not proof that validation passed
or the final output is correct. The real example uses stronger chained checks.

`resource` resolves through the prepared native environment's resource map. In the
newsroom example, Spawnfile declares `private-archive`, its immutable Git revision and
its `repos/newsroom-archive` mount. `path` selects one regular file within that source;
`sha256` authenticates its original bytes. Preserve its native workspace-relative path.
Reject absolute/traversing paths, escaping symlinks, absent files and hash mismatches.
A file existing or being mounted is not evidence that the agent read it.

`input.prompt` is the task message. Optional `input.data` becomes a deterministic
labeled JSON block; the exact resulting input is recorded. `input.files` becomes
subject-visible material in the prepared resource views. `reference.files` uses the
same selectors but remains evaluator-only, even if it comes from a public repository.
Do not feed YAML checks, private labels or future messages as part of the task.

Environment resources provide tools, schemas, catalogues and existing context as well
as evidence. Selecting case files does not replace those dependencies. A preparation
recipe specifies which base resources remain visible and which data views are filtered;
missing dependency closure or unbounded access to excluded answers blocks the trial.

## Environment fidelity and emulation

`setup.profile` selects a registered, versioned project recipe. Paideia's core does
not contain newsroom assignments, edition dates or Moltnet-specific business logic.
The recipe may restore snapshots, construct authentic fixture state and replay external
messages through the same public tool/transport contracts used by the subject.

The example's `fidelity: reconstructed`, `resource_views` and `memory: empty` are typed
parameters of its proposed newsroom recipe. They explicitly distinguish recreated
assignment/empty memory from an exact historical state restore. Selecting `exact`
fidelity must fail if required snapshots, runtime identities or observations are absent.
A recipe cannot report emulated events as observations of a real historical run.

Keep native tool names, schemas, model/runtime, filesystem paths, memory interfaces
and failure semantics where the task depends on them. Isolate mutable state, credentials
and external effects. Record every deviation and its effect on the claim being tested.
The preparation service may establish initial state; it must not do the subject's task.

Before preparing training/validation views, subtract all sealed-test inputs and
reference artifacts across the selected datasets, including older published outputs.
A date cutoff alone does not prevent cross-role leakage. Detect overlapping source
files as well as shared declared groups; unresolved overlap blocks the run.

Raw source snapshots, evaluator data and journals stay outside subject access. A filter
must cover alternate mounts, Git history, caches and memory, not merely hide a file
from a directory listing. Aggregate files also need row-level filtering; exclude later
and held-out byline entries without changing required headers or tool interfaces. Exclude every derived artifact carrying an excluded story
(headline/deck, edition index, composed page, search/feed entry, export or cache), not
just its article JSON. The preparer records the enumerated derivative classes it filters.
All selected records' reference outputs are evaluator-only, including earlier sibling
training articles. Other training inputs are not ambient context for the active record. Runtime policy and actual trace coverage need evidence.

## Explicit preparation bindings

The example's `setup` fields below are typed parameters of `newsroom/assigned-story`,
not universal newsroom behavior in the core. The registry resolves the recipe version
and its schema into the run manifest; unknown or unsupported parameters fail preflight.

| Recipe parameter | Required meaning |
| --- | --- |
| `isolation.container: fresh` | A new isolated container per independent trial |
| `isolation.mounts: trial-owned` | Fresh mutable volumes; immutable filtered source/tool views; no production host mounts |
| `isolation.control: fresh-credentials` | A private native control service and fresh token provisioned at the declared native path |
| `clock` | An emulated edition date, local time and timezone; recorded as reconstructed time |
| `delivery` | One authenticated native Moltnet mention carrying the record's task |
| `artifacts` | Named trusted collectors, scoped to this subject, edition and article |

`{context: edition}` and `{context: article_id}` resolve typed record values; they are
not string interpolation. Missing or wrong types fail before preparation. The newsroom
clock advances from the given instant in Europe/Berlin. All observable agent, tool and
runtime wall clocks must agree; unsupported clock control blocks the trial. Monotonic
latency and budget timers remain real. A prompt saying a historical date is insufficient.

Fixed absolute paths are container-internal, not permissions to mount production data.
The preparation manifest must account for every path, mount, network and credential.
Preserve native interfaces using fresh state at the same internal paths. Verify that
production volumes/control endpoints are unreachable; do not silently rewrite contracts.

The recipe creates authorized assignment/history state without posting the task or
waking the agent. After preparation, `input.prompt` becomes exactly one stored message
from the configured sender to the configured room, with the declared mention. Its
native mention mechanism supplies the wake; no additional direct wake is submitted.
For this recipe, message text is exactly `@` + mention + one LF + `input.prompt` bytes
as parsed from YAML; no trimming. The example’s `|` intentionally retains its final LF. Reject an embedded duplicate target mention. Record
the stored message bytes and transport identity before treating delivery as observed.
A delivery receipt proves delivery, not completion of the resulting native execution.

`setup.artifacts.accepted-article` binds `artifact:accepted-article` to a read-only
`newsroom/accepted-filing` collector. It selects the current accepted filing for this
trial's owner/edition/article, verifies authentic admission and history, and exposes
admitted JSON with original bytes and digest lineage. It is neither a validation
payload nor an arbitrary workspace file. No/multiple conflicting matches fail collection.
The collector never calls the filing mutator. `verify` requires the native acceptance
receipt and committed file bytes to agree through their distinct serialization identities.
The validation payload, admitted filing, file-byte hash and Git commit remain distinct.
Record `outputs` can name ordinary file artifacts; those cannot impersonate an acceptance
collector or override its binding. Conflicting artifact names fail resolution.

## Multiple turns inside one record

Use `turns` only when a task needs successive external inputs. Each turn has a unique
`id`, an `input`, optional observed `bind` declarations, and optional `checks` gates.
`after: {turn: request, outcome: completed}` requires actual predecessor completion
and its gates. Record state persists between these turns; different records reset it.

Under the [initial live policy](live-evaluation.md), turn gates must be mechanical;
semantic/embedding results may gate final record quality only, not continued work.

A `bind` names a trusted observation selector, matching predicate, distinct identity
and cardinality. `{binding: request.message.json.request_id}` references its typed value.
Missing or ambiguous required bindings stop dependent work. Ordinary strings are not
implicitly templated or evaluated.

A proposed `input.message` specifies network, credential-bound sender, target and
text/JSON for a fixture transport adapter. A scripted sensor answer is revealed only
when the prerequisite request exists. If delivery triggers a native wake, Paideia must
not submit a duplicate direct wake. Native execution/session behavior remains native.
The agent chooses and calls its own tools; turn sequencing supplies stimuli only.

## Evaluation language

Check nodes have an ID and one operation: `eval`, `all`, `any`, `not`, a resolved
result reference or a registered `use` ruleset. `with` binds typed ruleset parameters.
Unknown rule IDs, cycles, unsupported options and missing observations are explicit
failures to resolve or evaluate, not opportunities for best-effort passing.

| Operation | Example meaning |
| --- | --- |
| `equals`, `contains-any`, `json-schema` | Exact text, strings in an output, structural validation |
| `tool-called`, `tool-count` | Authentic native tool occurrence/count, with declared outcome or phase |
| `tool-sequence` | Ordered successful calls and bindings between their arguments/results |
| `llm-rubric` | Semantic judgment using a fixed prompt and explicit inference route |
| `embedding-similarity` | Similarity with a declared model, metric and calibration |
| Registered project evaluator | Typed domain checks against real accepted state/artifacts |
| `all`, `any`, `not` | Logical composition with explicit unknown/error semantics |

Selectors include `output.text`, `artifact:name#/json/pointer`, `input:files` and
resolved binding/check evidence. The environment adapter declares trusted collected
artifacts; an agent-supplied pathname or claimed receipt cannot manufacture acceptance.
`input:files` supplies only verified selected input bytes to a judge, not references or
future test labels. Later delivered evidence needs an explicit recorded projection.

`llm-rubric.rubric` is exactly one of `{prompt: <inline text>}` or `{file: <path>}`.
Relative rubric/schema paths resolve from the dataset file. Inline prompts make a
dataset self-contained. Judges receive fixed rubrics and declared evidence as data;
subject output cannot override instructions. A symbolic `judge` name must resolve to
an explicit invocation-selected inference route; record its identity/version and fail
resolution if absent. Return typed scores, verdicts, reasons
and cited spans. Calibrate against human judgments before making quality claims.

Judge citations name `input` or the optional `evidence` source. Selected values are
encoded once in the source-data JSON. A quote must match an exact substring of that
source's compact JSON representation, or of one original string value within it
(including nested objects, arrays and input-file contents). Plain-text sources are
matched as their original text. Literal quotes, newlines and backslashes retain their
meaning after JSON decoding. Validation never trims, normalizes or joins separate
string values, and text from another named source cannot validate a citation.

`tool-sequence.order: happens-before` means predecessor completion precedes successor
dispatch. Matching is existential over ordered, distinct successful call tuples with
consistent bindings; repair attempts may occur between matched calls. Retain all matches
and report the lexicographically earliest tuple of native dispatch sequence numbers as
the witness. Incomplete order/correlation evidence remains unknown, not a guessed match.
Optional `ending_at: {artifact: name, event: accepted-call}` requires the final matched
call to be the artifact collector's actual accepting call. The newsroom datasets use
this so an earlier valid filing cannot excuse an unvalidated later accepted version.
The read-only collector joins authentic receipt and captured call identity; absent or
conflicting lineage cannot satisfy the gate. Step `bind` captures typed fields for later predicates; JSON object comparison
ignores property order but preserves array order and values. `where.cel` uses the implemented CEL evaluator for typed predicates, with bounded
expressions and an explicit environment. It cannot execute arbitrary processes.

The CEL predicate scope exposes `call` (the candidate native call), `context` (typed
record context) and `bindings` (prior matched-step bindings); no ambient globals.
Normalized calls expose `call.id`, `call.wake_id`, `call.args`, `call.result` and
`call.success`, with native dispatch/completion events and their correlation IDs.
`wake_id` must come from the actual active native host execution, never a fabricated
record ID or room message ID. Adapters unable to observe a required field return
unknown; an event-key equality check cannot pass by substituting an unrelated ID.

Keep raw tool identities and results alongside normalized capture fields. A shell
command mentioning a tool name is not a call. Counts/absence require complete relevant
observation; a known-tool blacklist cannot establish that Internet research was blocked.

```yaml
all:
  - eval: tool-called
    tool: validate
    outcome: succeeded
  - not:
      eval: contains-any
      input: artifact:article#/body
      values: ["as an AI", "this filing can say"]
```

For an array of body strings, `contains-any` matches any string element. The predicate
above is a check-node fragment, not a complete dataset. It catches named phrases, not
all undesirable prose. JSON syntax/shape cannot establish source truth or writing quality.

## Progressive scores and result semantics

`checks` is shorthand for one all-required stage. `stages` is an ordered sequence with
explicit gates. `when` controls evaluator eligibility; observed event order is a
separate assertion. IDs are scoped to the shared plan, record additions or turn checks.
Live checks have their own namespace. No implicit cross-record dependencies.

```yaml
id: writing
when: {passed: mechanics}
checks:
  - id: grounded
    eval: llm-rubric
    input: artifact:article
    evidence: input:files
    judge: editorial-subscription
    rubric: {prompt: Grade support for material claims and cite evidence spans.}
    minimum: 0.90
  - id: prose
    eval: llm-rubric
    input: artifact:article#/body
    judge: editorial-subscription
    rubric: {prompt: Grade clarity and paragraph progression; cite concrete passages.}
    minimum: 0.80
score:
  linear: {grounded: 0.65, prose: 0.35}
gate:
  all:
    - {passed: grounded}
    - {passed: prose}
    - {score: writing, at_least: 0.88}
```

This is a stage fragment. The complete real datasets show it inside a dataset plan.
A weighted sum never compensates for a failed hard gate. Missing or skipped components
retain their contribution to the denominator; show uncertainty/coverage rather than
renormalizing surviving scores. Fixed weights must be nonnegative and sum to one.

- `pass`: criterion met; a score may still be fractional.
- `fail`: observed evidence violates the criterion.
- `unknown`: observation is insufficient; never satisfies a required check.
- `error`: infrastructure, evaluator, input or budget failure.
- `skipped`: an explicit dependency or recorded trial termination prevented evaluation; never success.

`not` reverses pass/fail only. `all` needs every operand to pass; `any` needs a passing
operand, retaining other diagnostics. No absence claim passes over incomplete capture.
Checks and scoring always retain evidence and failure reasons.

The [approved initial live policy](live-evaluation.md) permits decisive mechanical
hard stops only. Semantic checkpoints stay advisory; terminal quality gates remain.

## Training, testing and prompt resources

The native project owns instructions, SOUL, textual skills, references, tool bindings
and model settings. The training invocation allowlists editable files/heading subtrees.
Everything else stays locked. Ambiguous heading selection, undeclared edits or changes
to a locked policy fail candidate resolution. Plain Markdown is first-class; templates
are optional and must not become an extra required authoring language.

DSPy edits candidate copies through an explicit multi-file component mapping. Use the
native compiler/adapter to prepare a fresh subject for each changed candidate and
independent record/repetition. Propagate edits to every derived native/mirrored copy.
Installed, discovered, loaded and followed are separate claims requiring observations.

Train data supplies optimizer feedback. Candidate selection uses training-only group
partitions or an optional validation dataset. Freeze the candidate before the final
test comparison with baseline. Reject duplicate record identity, repeated membership
and evidence families shared between those roles. Dataset membership is explicit and
immutable for the run. One case per role illustrates syntax, not statistical evidence.

For a train/test comparison, the normalized shared evaluation plan must have the same
digest: evaluator/judge versions, rubrics, gates, thresholds, weights and live policy. Resolve both
dataset declarations before work; fail on drift instead of comparing different criteria.
Keeping both plans inline avoids a mandatory third rules file. The shared-plan digest gate is
implemented and checked before native training.

The current runner returns one stored trial per metric request; held-out records
have equal weight. It does not expose a configurable repetition count. Infrastructure
failures abort scoring instead of silently removing records or assigning a zero.
Rescoring a capture is not a new independent trial; changing prompts requires rerunning
the native subject. Report quality, coverage, latency and separately observed usage for
subject, optimizer and judges. Missing usage is unknown, never zero.

Subscription routes for optimization and judging are independently selected from the
subject. All integrations must resolve/authenticate before work; never fall back silently
to a paid API. Embeddings declare their own provider and billing route. Export local
candidate diffs and evidence; prompt optimization never deploys changes automatically.
