# Implemented system and evidence

Paideia now has a working local evaluation and prompt-training path. This page
separates the executable core from the project integrations still being designed.

## Working components

| Component | Implemented behavior |
| --- | --- |
| Datasets | Strict YAML, inline records and named fixtures, typed bindings, versioned criteria, pinned input selectors, split checks |
| Candidates | Immutable multi-file Markdown, locked files, whole-file or heading edits, explicit destinations and content hashes |
| Native trials | Fresh workspace and runtime state, protected evaluator paths, captured observations, bounded cancellation, declared trace coverage |
| Evaluators | Text/JSON schema, CEL predicates, tool counts and sequences, logic, staged gates, weighted scores, semantic rubrics, explicit embedding/custom providers |
| Storage | Immutable manifests and blobs, append-only events/evaluations, hash verification, sealed-test access checks |
| Training | Real DSPy GEPA, subscription reflection, bounded trials/proposals, validation selection and frozen held-out comparison |
| Viewer | Local persisted experiment projection, live refresh and saved-run viewing; page requests never invoke an agent or judge |
| Tooling | TypeScript boundaries, size/layout guides, per-file coverage and a locked, tested Python DSPy bridge |

The CLI supports native Codex and Daimon, explicit Markdown resources, dataset
validation, evaluation, training and viewing. The TypeScript API exposes the
underlying contracts for integrations. There is no production deployment command.

The public `runStoredTrial` preparation hook receives `(paths, signal, context)`.
Its isolated context copy identifies this trial, phase, resolved record, candidate
and resource mappings, so a shared training hook can prepare the correct native
assignment and tools for each attempt. This is trusted evaluator-side data;
criteria, reference answers and future stimuli must not become subject inputs.
Instruction resources remain the declared candidate bytes. Native compilation
and project-specific environment construction still belong to their integrations.

The public `rescoreStoredTrial` API explicitly reevaluates final stages over a stored
capture without rerunning the subject. It appends a separate evaluation and preserves
the immutable original, historical live-stop evidence and per-turn results; it does
not reevaluate live or per-turn checks. Semantic rescoring uses explicitly supplied
inference routes. There is no replay CLI; saved-run viewing does not rescore.

## Native acceptance

On 2026-09-13 the [formatting example](../examples/native-formatting/README.md)
ran actual DSPy 3.3.1 / GEPA 0.1.4 with native Codex trials and Claude subscription
reflection. Six metric calls and one proposal changed the unseen Gamma result:

| Adapter | Baseline | Frozen revision |
| --- | --- | --- |
| Codex | `Gamma`, failed | `ack:gamma`, passed |
| Daimon | `Gamma`, failed | `ack:gamma`, passed |

Original prompt hashes and locked identity bytes stayed unchanged. Four held-out
captures reproduced their mechanical evaluation results without new subject or
inference calls. All 55 stored files remained byte-identical; optimizer reads of
test captures failed. The local receipt is identified by
`sha256:3756449521a825a4c884b019436ae9fc689552b5e5a875ccc3bb0b07cc041188`.

This proves native execution, optimization, candidate propagation, access policy
and replay compose. Three short records do not establish statistical
generalization, writing quality or fidelity to a newsroom environment.

## Remaining integrations

- Codex has native multi-wake continuation. The current Daimon CLI route supports
  one wake with multiple steps; memory-backed episodes need further public seams.
- Native skills need genuine discovery/loading integrations. Supporting files and
  explicit instructions work; copying a `SKILL.md` is not advertised as loading it.
- Spawnfile extraction, filtered source views, `.spawnignore` and `spawnfile train`
  remain owner-level integrations. The newsroom example cannot yet reproduce its
  production tools, memory, communication and complete prompting environment.
- Claude-as-subject, standalone Pi and OpenClaw need independent native adapters.
  Claude is currently the subscription inference route for DSPy and judges.
- Captured-run-to-dataset distillation and optional prompt templates remain future
  features. Authored dataset YAML and ordinary Markdown work today.
- Embedding evaluators require an explicitly supplied provider and calibration;
  there is no default hosted embedding route or silent API billing fallback.

Mechanical hard stops, native completion, observation completeness and quality
scores are separate facts. Unknown remote cancellation and unobserved tools remain
unknown. An interrupted capture cannot be advertised as a completed fresh trial.
A selected decisive mechanical witness ends the trial and skips unnecessary terminal
judges. Already-started work receives cancellation and bounded settlement; a host
that fails to settle remains an infrastructure failure, with the witness preserved.

## Verification and release

Unit/conformance tests use deterministic native boundaries to exercise failures;
the native acceptance above is separate evidence. Run the complete commands in
the [development guide](development.md), including TypeScript and Python coverage
and the local documentation build. Paid native probes are not part of CI.

All generated traces, reports, environments and review receipts stay ignored and
local. The package is private, the feature branch is unmerged and the documentation
site has no deployment workflow. Successful training does not authorize deployment.
