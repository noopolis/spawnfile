# Training controls in the dataset

`train.paideia.yaml` may contain `training` beside its records and criteria. No
additional experiment or judge configuration file is required. This document
describes the validated authoring contract; provider execution, caching and CLI
integration must independently implement each control before accepting a run.

```yaml
schema: paideia.dataset.v1
id: writing-development
training:
  models:
    fast:
      provider: grok-subscription
      model: your-installed-model
      reasoning_effort: low
    reflection:
      provider: grok-subscription
      model: your-installed-model
      reasoning_effort: medium
    local:
      provider: ollama
      model: your-local-model
      endpoint: http://localhost:11434
  judges:
    clarity:
      model: fast
      fallbacks: [local]
      attempts: 2
      timeout_ms: 60000
      citation_repairs: 1
      template:
        language: jinja
        text: "Evaluate only this criterion: {{ rubric }}"
  optimizer:
    model: reflection
  budget:
    max_trials: 16
    max_proposals: 4
    timeout_ms: 3600000
  cache:
    mode: persistent
    namespace: editorial-calibration-v1
    max_entries: 1000
  recovery:
    max_attempts: 2
  test: test.paideia.yaml
  validation_groups: [held-out-development]
  seed: 0
checks:
  - id: clear
    eval: llm-rubric
    input: output.text
    judge: clarity
    rubric:
      prompt: Every paragraph adds a distinct fact or explanation.
    minimum: 0.8
records:
  - id: first
    group: training-example
    input:
      prompt: Explain the supplied evidence plainly.
```

The names under `models` are reusable references. Judges and the optimizer select
a primary name and ordered fallback names. A fallback must differ from the primary
and every referenced model must exist. Provider names currently accepted by this
schema are `claude-subscription`, `grok-subscription` and `ollama`; only Ollama accepts
an endpoint. Endpoints cannot contain credentials, queries or fragments. Model names
are provider-specific strings, not a claim that a particular model is installed.

Grok models accept `reasoning_effort: low | medium | high | xhigh`. Omission means
explicit `medium`; the process never inherits effort from local Grok configuration.
Use separate named model entries to give focused judges and prompt optimization
different efforts. Effort changes invalidate exact judge reuse. Other providers
reject this field until their adapters support it.

Judge templates declare Jinja source; parsing validates their shape, while the
evaluation layer owns rendering and rejects unsupported template behavior before
inference. Subject output and source evidence remain separately supplied evaluator
data. They do not become template instructions. Existing inline rubric prompts and
rubric files remain valid without a judge template.

The parser rejects unknown fields, fractional or nonpositive limits, more than ten
attempts, attempts exceeding the primary plus fallback count, deadlines beyond one
hour, and cache capacity beyond ten thousand entries. Each declared route is tried at
most once; attempts bounds the total routes attempted, not retries per model.
Trial and proposal budgets cannot exceed 10,000 and 1,000 respectively.
Seed is a nonnegative safe integer; citation repair is either zero or one. A test
path is contained and relative to the authored dataset. Criteria batteries continue
to use ordinary checks, stages, gates and weighted scores.

Resolution preserves a detached copy of the configuration. Declaring a judge does
not install one: a caller must construct and register its runtime implementation.
The resolver combines its registered version with a digest of the authored judge
policy and referenced models. Changing a model, endpoint, template or fallback
therefore changes the shared evaluation identity. Optimizer budgets and cache
capacity do not change that scoring identity. Train and test must resolve the same
effective judge policy before their scores can be compared.

Rendering uses the pinned Hugging Face Jinja 0.5.10 engine, including its supported
conditions, loops, macros and filters. It does not promise every Python Jinja
extension. Syntax preflight and rendering run in a fresh worker, with a one-second
deadline and 64 MiB old-generation heap limit. Source is limited to 32 KiB, rubric
text to 128 KiB and output to 256 KiB. Cancellation terminates the worker. The only
authored context value is `rubric`; wall-clock access is disabled so the same
inputs do not acquire time-dependent instructions. Unsupported syntax, includes,
render failures and exhausted limits fail before inference.

Exact caching is invocation-local LRU reuse, bounded by the declared entry count
and a 32 MiB internal byte ceiling. It does not promise durable cross-command
reuse or provider-side prompt caching. Changing model routing, template, criterion
or selected evidence must prevent inappropriate reuse.

## Execution and limits

The CLI now consumes these controls directly. `spawnfile train` forwards the
canonical agent context; Paideia loads the named judges and optimizer, performs
preflight, runs bounded DSPy optimization, freezes selection, and evaluates the
sealed test. A registered isolated project preparation is still required for a
canonical Spawnfile environment. Install the packaged DSPy bridge executable
`paideia-dspy` on PATH, or select its explicit executable with `--bridge-command`.

Classified quota, transport, unavailable, individual attempt timeout and attested
`invalid-response` schema failures advance to the next configured model. `timeout_ms` bounds the whole route, including
all attempts and audit writes. Each attempt receives an equal share of remaining
time divided by remaining authored attempts; unused time carries forward. With
`attempts: 2` and `timeout_ms: 180000`, the first model gets at most 90 seconds,
leaving the rest for its fallback. Authentication, native protocol failures, operator
cancellation and exhaustion of the overall deadline stop that request. A valid failing grade is final. Citation repair, when selected,
can change only citations, never the score, verdict or reasons. Failed attempts
retain their known token usage and actual model identities where available.

The train YAML supplies the default test path, optimizer, budgets, seed and
validation groups. Explicit scalar CLI budget overrides remain available. Judge
model overrides that conflict with an authored route are rejected. `--dry-run`
constructs no provider and values every permitted fallback attempt; unknown model
prices remain unknown. These are API-equivalent estimates, not subscription fees
or spending guarantees.

DSPy proposals request a JSON object whose exact keys are the selected editable
resources and whose values are replacement text. Grok and Claude use their native
JSON-schema controls; local Ollama uses `format`. Paideia also validates the whole
completed response before accepting it, then checks the candidate's edit policy.
This does not change the authored rubric or permit edits to locked sections.
Custom inference integrations receive optional `responseSchema`; unsupported
schema controls must be rejected. Native tool isolation does not imply the CLI's
built-in prompt context has been removed.

Cache hits preserve the original attempt IDs, actual model identity and historical
usage as provenance. They incur no new judge call or current token charge. Exact
reuse binds the frozen route, rendered instructions, sources, threshold, dataset
identity and phase. A held-out judgment cannot satisfy a training request.

Persistent caches use a private SQLite store, an explicit calibration namespace,
entry and payload-byte bounds, and oldest-insertion eviction. Change the namespace
when a mutable model alias or calibration changes. Transactions survive process
exit without stale application locks; hashes and schema checks reject corrupted
entries. This is host-owned storage, outside the subject's accessible paths. The
first valid exact judgment wins, including a failing grade. Infrastructure errors
and invalid responses are never cached. A cache hit is reused evidence, not an
independent native trial or a new quality measurement.

`cache.mode: persistent` requires a nonblank `namespace`. Its default directory is
inside the command output; optional `directory` is contained beneath the dataset
directory, with symbolic path components rejected. A trusted container integration
can provide `judgeCacheRoot`, an existing canonical writable directory. Its explicit
relative YAML directory then resolves beneath that base; without a YAML directory,
`judge-cache` is used beneath the base. The dataset stays readonly. Cache identities
and namespaces are unchanged, and the actual cache directory is protected from the
subject. Dry-run creates no cache or directories. The same namespace and exact
evidence can reuse judgments across commands; distinct judge names remain separate.

## Interruption and resume

Repeat the same command with `--resume` and the same `--out`. Resume validates
the candidate, resources, dataset and criterion identities, runtime integration,
budgets and optimizer checkpoint. Presentation flags may change. Native Spawnfile
integrations must provide an immutable execution identity; changed runtime images,
tools or fixture evidence reject resume.

Completed native work is restored from immutable captures. A settled native result
whose judgment failed transiently can be rescored without rewriting the article.
`recovery.max_attempts` bounds these rescoring attempts across invocations (default
two, zero disables them). Valid failed grades are never retried for a better score.
Incomplete native execution or unconfirmed shutdown blocks reuse.

The real GEPA state, sampler state and callback journal resume together. Trial and
proposal attempt budgets remain cumulative; each command invocation has its own
deadline. A process lock prevents overlapping commands and releases on process
death. Reports distinguish new trials, restored captures and rescoring. Resume is
not production deployment and does not alter the selected native source files.

With `--view`, persisted measurements stream to the local console. The displayed
chart can rise, fall or stay flat. Browser updates invoke no agent or judge work.
Each scored criterion shows its authored weight and measured contribution; gates
remain independent of that score.

Stable instructions precede source data, allowing provider prefix caching where
supported; only reported cache counters establish actual reuse. Exact response
caching does not imply semantic similarity caching or optimizer checkpoint resume.
Missing research remains a blocked task.

The acceptance tests use the real DSPy bridge with isolated deterministic subject
and inference fixtures. They verify YAML-only control, failure routing, frozen
held-out comparison and persisted artifacts. They do not establish that a
particular newsroom agent's writing improves, nor guarantee convergence.

DSPy receives a fresh private home for each bridge process, separate from the
operator's home and provider credentials. Checkpointed runs place it under the
protected checkpoint directory. Its disposable caches are removed after confirmed
process closure and are not resume state; uncertain closure preserves them and
fails the optimization.


## Proposal memory and diversity

```yaml
training:
  optimizer:
    model: reflection
    proposal:
      strategy: rewrite
      min_change: 0.15
      max_attempts: 2
      history_entries: 20
      history_bytes: 65536
```

`rewrite` asks for structural changes inside already-editable resources, with a
hypothesis and predicted criterion impacts. The default is `refine`. Prior training
prompt bodies, results, failed proposals and token usage inform each generation;
validation text and sealed test data stay excluded. Full originals remain durable,
while explicit excerpts and omission counts bound the reflection context.

Whitespace-equivalent and previously proposed bundles are rejected before native
trials. `min_change` (default `0`, range `0–1`) adds a token-trigram lexical-distance
guard; it does not measure semantic quality. Repair attempts (default `2`, range
`1–5`) consume the existing total `max_proposals` budget. Exhaustion stops cleanly
with the measured best candidate; provider failures remain failures.

History defaults to `20` entries (`1–100`) and `65536` bytes (`1024–262144`), with
criterion score vectors and native usage ahead of optional prose. These are
reflection bounds, not storage limits or a promise of convergence. See the
[bridge contract](../bridges/dspy/README.md#proposal-memory-and-authored-rewrites)
for response-envelope, truncation and exact-resume semantics.

[Focused evidence-ID judges and native Ollama controls](../src/evaluation/semantic/README.md)
describes the separate judge authoring and calibration surface.

`spawnfile train --dry-run` estimates the authored workload without loading native
preparation plugins, credentials, containers or models. It still checks YAML,
fixtures, context/binding references, criterion files, judge routes and dataset
splits. Its `preparationValidation` lists profiles whose availability, parameter
semantics and override permissions remain **unverified**. A cost estimate is not
execution readiness; normal training validates these with the installed integration.
The estimate uses a separate projection containing no executable task inputs.

A completed provider response that passes native authentication, isolation and
completion checks but fails the requested JSON schema is `invalid-response`.
It may use the next configured fallback within the same attempt/deadline budget;
valid grades are never retried. Completed native captures may use existing bounded
measurement recovery for this class. Framing, unfinished output, authentication
and tool-isolation failures remain terminal, as do older generic protocol errors.
Failed answer diagnostics are retained only in protected evaluator audit events.
Oversized answers are explicitly omitted with their byte count and SHA-256; raw
provider stderr and hidden reasoning are never captured by this diagnostic path.

## Repair measurements after an evaluator upgrade

`spawnfile train … --repair-measurements <parent-output> --out <fresh-output>`
creates a separate experiment with explicit parent lineage. It is not an exact
resume: ordinary `--resume` still rejects changed execution identities. The public
Spawnfile training preparation must prove unchanged native worker, setup, pinned
compiler, project inputs and dataset semantics before allowing future native work.
For older runs without an automatic preparation witness, the command also requires
`--repair-witness <preserved-image-witness>`; an operator assertion is insufficient.

The parent is projected read-only. Original native reports, prompts, valid grades,
trial IDs, proposal history and costs remain intact. Only failed final semantic
checks are measured again; valid passing and failing checks are retained exactly.
New rescoring records link to the original capture and compatibility receipt, and
aggregate scores are recalculated. Native trials and completed optimizer calls are
not repeated. Recovery and optimizer budgets remain cumulative across the fork.

The initial repair contract accepts development-stage parents only. Frozen
selection, sealed-test state, unconfirmed native shutdown, changed criteria and
unsupported runtime compatibility are rejected. A repaired measurement is not a
new independent native trial or evidence of a writing improvement. The child can
subsequently use ordinary `--resume` with the same repair declaration. `--dry-run`
does not import captures or invoke models and conservatively estimates a full run;
it does not certify that a parent is compatible.

## Compare a fixed authored candidate

Use `spawnfile train` with `training.comparison` to measure a baseline against a
supplied candidate, without DSPy or optimizer calls. Both arms use the same declared
resources, runtime, tools, cases and frozen criteria. For example:

```yaml
training:
  models:
    editor: { provider: grok-subscription, model: grok-4.6 }
  judges:
    prose: { model: editor, protocol: evidence-ids, timeout_ms: 10000 }
  comparison:
    candidate:
      name: skill-guided
      replacements:
        - resource: agents/foreman/AGENTS.md
          source: variants/skill-guided/AGENTS.md
  validation_groups: [validation]
  test: test.paideia.yaml
  budget: { max_trials: 10, timeout_ms: 3600000 }
```

`resource` names an already-declared editable candidate file. `source` is a bounded
UTF-8 file relative to the training dataset directory; it cannot escape that root.
Complete replacement bytes must preserve every locked section. Missing, unchanged,
undeclared and locked replacements fail before native execution. File contents enter
the command identity: changing bytes at the same path rejects exact `--resume`.
Skills can remain locked and identical in both arms while only their instruction
index differs. Available native skill catalogs can still affect either arm; this
comparison does not establish that unused skills have zero context cost.

Each train, validation and test case runs once per arm, baseline then authored,
using fresh native trials. `max_trials` must cover the complete pair count (five
cases require ten trials). There is no optimizer selection or automatic promotion.
Omit `optimizer`, `max_proposals` and bridge flags. `--dry-run` estimates those exact
pairs and judge routes with zero optimizer cost, retaining the usual unknown-cost
and unverified-preparation disclosures.

The separate `paideia.comparison.v1` report records both candidate identities,
per-case scores and differences, original captures and costs. The cockpit names
both arms and shows their chronological measurements without a GEPA panel. Valid
failed grades are retained; infrastructure interruptions remain incomplete. Exact
`--resume` verifies and reuses completed captures, and existing bounded recovery
can rescore eligible judge outages without repeating the subject. Measurement-repair
forks are currently rejected for comparison runs. Exit status reflects the authored
arm's held-out verdicts, not a claim of statistical superiority.
