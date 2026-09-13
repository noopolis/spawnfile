# Architecture

Open the [local architectural view](architecture.html) for component, YAML, native-trial
and training diagrams.

These are approved module boundaries, not an implemented system. YAML syntax,
adapter contracts and template selection still require concrete agreement and
conformance tests. The seeded folders currently contain guidance only.

```text
YAML cases + candidate files + fixtures
                   ↓
          Isolated experiment ←──────────┐
                   ↓                     │
        Native subject adapter           │
                   ↓                     │ DSPy: training feedback only
 Captured events, inputs and artifacts   │
                   ↓                     │
      Evaluation gates and scores ───────┘
                   ↓
         Validation selection
                   ↓
     Frozen candidate: sealed test
                   ↓
  Local evidence and candidate files
```

## Ownership

| Module | Owns | Does not own |
|---|---|---|
| contracts | Neutral schemas, IDs, results and capability interfaces | Runtime SDKs or filesystem access |
| cases | YAML parsing, references, suites and split validation | Agent execution or evaluators |
| candidates | Instruction/skill trees, editable boundaries and provenance | Runtime config or policy changes |
| experiments | Isolated trials, lifecycle, budgets and phase access | Agent cognition or organization strategy |
| adapters | Native subject preparation, execution and cancellation | Evaluation semantics or optimizer inference |
| capture | Observations, coverage, provenance and snapshots | Invented hidden events or success claims |
| evaluation | Evaluator registration, execution and shared result semantics | Subject execution or candidate rewriting |
| evaluation/logic | Logical nodes, conditions, scores and gates | Provider calls or event transport |
| evaluation/mechanical | Text/schema/tool/artifact checks and causal relationships | LLM judgments |
| evaluation/semantic | Rubric judgments, evidence and calibration | Credentials or subject control |
| evaluation/embedding | Declared similarity metrics and calibration | Implicit embedding support from text CLIs |
| optimization | Candidate feedback, editable components and selection | Sealed-test feedback or deployment |
| inference | Subscription text generation and embedding providers | The subject's tool loop |
| storage | Ledger, immutable artifacts and replay queries | Recomputing scores or launching agents |
| cli | User commands and explicit composition | Duplicate evaluation logic |
| bridges/dspy | Versioned boundary to real Python DSPy | TypeScript core policy |
| viewer | Local live/replay presentation of persisted events | Cognition on page load or score changes |
| website | Astro/Starlight product documentation | Private experiments or the local training UI |

These modules initially belong to one package. Do not create separate packages
merely because directories exist. Neutral contracts stay low in the dependency
graph. Integrations consume public contracts and inject capabilities; core
evaluation cannot import a runtime adapter's implementation.

## Candidates and evidence

A candidate is a versioned set of instructions, skills, supporting Markdown and
examples, mapped from existing project sources to declared native destinations.
Authors control editable/locked resources. Templates are optional, and rendering
alone does not expose a resource to DSPy; the optimizer needs an explicit mapping.

Record source hashes, rendered contents, supplied inputs and observed dynamic
loading separately. An installed skill does not prove loading or compliance.
Unavailable observations stay explicit. Changed instructions require a new
isolated subject run; a score over an old capture is a rescore.

Every attempt receives fresh frozen evidence, initial files and memory fixtures.
Rubrics, hidden labels, tool journals and authoritative receipts stay outside the
subject's writable workspace. Illustrative project integrations belong in examples/;
the [Example Newsroom proposal](../examples/newsroom-reporting/README.md) exercises the language
without importing private evidence. Private corpora and production state remain in
their owning repositories; executable generic sample suites belong in evals/.

## Evaluation and optimization

YAML combines reusable predicates and evaluators without executable code. Event
ordering describes what the subject did; evaluation scheduling describes when
checks run. Preserve this distinction in the UI and ledger.

Results include pass, fail, unknown, error and skipped. Missing evidence cannot
pass a mandatory gate; absence requires a complete declared observation scope.
Weighted scores retain their denominator and disclose missing coverage. Gates
cannot be offset by better prose or another weighted component.

Subject adapters and subscription inference remain independent. DSPy reflection
and semantic judging use explicit inference routes; unsupported controls and
quota/authentication failures surface. Embeddings have a separate declared
backend. Usage separates subject, optimizer, judge and embedding work.

Training feedback changes only editable resources. Validation selects; the sealed
test compares the frozen candidate and baseline under the same conditions. Once
test feedback influences another revision, that holdout becomes development data.

## First working acceptance

1. Run the same case and evaluator plan through two real, independent native
   harnesses, including one outside Daimon. Verify actual tool/artifact effects.
2. Capture once and rescore without invoking the subject. Mutations must reject
   missing tools, failed/reordered actions, wrong artifacts and incomplete traces.
3. Change a DSPy component and prove the native subject consumed the change.
   Locked resource edits fail before starting a subject.
4. Exercise subscription DSPy and judging without API fallback, including missing
   authentication, quota exhaustion and unsupported controls.
5. Complete a bounded train/validation/sealed-test comparison with cost, quality
   and coverage, then replay locally without new model calls.

GitHub Pages remains deferred until real native-agent optimization is demonstrated
and publishing is approved. The future site uses a project base path and no custom
domain. No product or site has been built or deployed by this seed.
