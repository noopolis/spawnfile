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
    model: fast
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

Only settled quota, transport or unavailable failures advance to the next
configured model. Authentication, malformed judgments, cancellation and timeouts
stop that request. A valid failing grade is final. Citation repair, when selected,
can change only citations, never the score, verdict or reasons. Failed attempts
retain their known token usage and actual model identities where available.

The train YAML supplies the default test path, optimizer, budgets, seed and
validation groups. Explicit scalar CLI budget overrides remain available. Judge
model overrides that conflict with an authored route are rejected. `--dry-run`
constructs no provider and values every permitted fallback attempt; unknown model
prices remain unknown. These are API-equivalent estimates, not subscription fees
or spending guarantees.

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
directory, with symbolic path components rejected. The same namespace and exact
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
