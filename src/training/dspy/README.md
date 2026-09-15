# DSPy native-trial bridge

This is the real released `dspy.GEPA` optimizer behind a versioned JSONL process.
TypeScript supplies subscription reflection and isolated native subject trials;
Python contains no subject tool loop, rubric implementation, dataset loader or
paid API route. See [the protocol](protocol.md) for messages and ownership.

From the repository root of a clean checkout, with `uv` installed:

```sh
cd bridges/dspy
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -r requirements.lock
uv pip install --python .venv/bin/python --no-deps -e .
.venv/bin/python -m pytest
.venv/bin/python -c 'import json; data=json.load(open("coverage.json")); summaries=[data["totals"],*[file["summary"] for file in data["files"].values()]]; assert all(s["covered_lines"] >= .9*s["num_statements"] and s["covered_branches"] >= .9*s["num_branches"] for s in summaries), "Every module and the total must reach 90% lines and branches"; print("COVERAGE: every module and total passed 90% lines and branches")'
```

The installed executable is `.venv/bin/paideia-dspy`. It waits for the initial
optimization message on stdin, issues host callbacks on stdout, then emits an
explicit terminal result/error and exits. The TypeScript supervisor must answer
callbacks, enforce native isolation/candidate policy, and own cancellation of both
the process and its outstanding host work.

The released integration uses normal named `dspy.Predict` components and the public
custom-adapter/proposer seams. One native trial consumes the entire candidate; each
Predict records the same authentic output/capture as a component trace. All files
are optimized together. A single-line JSON envelope prevents DSPy's instruction
normalization from stripping Markdown whitespace before native evaluation.
The proposer requests native JSON-schema output for exactly its selected string
resources. The TypeScript host validates the completed response independently of
the provider; unsupported schemas fail before cognition. Plain-text legacy callbacks
remain readable, but new real schema-constrained generations require bare JSON.
The bridge's compatible model decoder accepts bare JSON or exactly one whole lowercase `json`
code fence with LF delimiters; surrounding prose, multiple fences and arbitrary
JSON extraction are rejected. Duplicate keys, nonfinite constants and changes to
the selected resource set remain invalid. Replacement text is never trimmed.
This model-response normalization does not change the strict host JSONL transport
or trigger another model call.

The conformance test uses the actual installed optimizer with a **simulated host**:
two proposals update two files, seven trial callbacks compare three candidates,
and validation scores progress from 0 to 0.5 to 1. It checks final candidate lineage,
native callback bytes, held-out validation text exclusion, and real JSONL process
completion. Auth/quota errors, invalid frames/replies, unsupported generation
controls, changed component sets and budget overrun are negative tests.

These tests establish the bridge seam. Real subscription generations and native
agent acceptance are separate TypeScript integration evidence; simulated scores
are not measurements of a real agent. Python 3.14.7 was used for the checked run.

The checkpoint conformance test interrupts actual GEPA mid-iteration, restores its
paired state and sampler, then verifies seven unique native captures and two total
generations. Repeated restoration returns the same selected components without new
host work. Corrupt/changed identities fail; cumulative failed-attempt offsets cannot
reset the proposal or evaluation budgets. All checkpoint directories are private
local evaluator state, never candidate inputs.

Explicit host-authorized checkpoint forks preserve that paired state under a new
experiment/execution identity. Exact parent bytes and unchanged optimizer inputs
are verified before callbacks; the child durably records lineage and never writes
the parent. The real GEPA fork test resumes a checkpoint two completed callbacks
behind the host journal, replays those exact calls, then continues pending call 17
without duplicate native or generation work. This is a trusted-state continuation,
not permission to change criteria, budgets or historical successful measurements.

## Proposal memory and authored rewrites

The optimizer reflects on earlier **training** prompts and results, including
criterion score/status vectors, native token usage, rejected proposals, hypotheses
and expected impacts. Validation remains scalar selection evidence; neither its
text nor sealed test data enters reflection. GEPA still owns search and selection.

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

Defaults are `refine`, `0`, `2`, `20`, and `65536`. Omitted `proposal` retains the
legacy exact resource-map response; authored policy requests a structured
`components`, `hypothesis`, `expectedImpact` envelope. Expected impacts are the
optimizer's predictions, never measured grades. Rewrite permits reorganizing only
already-editable text; all locked resource policies still apply.

Whitespace-equivalent or previously proposed bundles never run a native trial.
`min_change` measures token-trigram Jaccard distance from the parent, a lexical
novelty guard rather than semantic quality. Each repair generation consumes the
existing total proposal budget. Once `max_attempts` is exhausted, GEPA skips the
proposal and stops cleanly with its measured best candidate. Real provider and
malformed-protocol failures retain their failure classification.

Full prompt bodies, raw train outputs and callback results remain in protected
checkpoints and original trial reports. Reflection receives recent chronological
entries, with per-criterion scores/status and native usage before optional prose.
Large prompt/reason/output fields carry explicit excerpts, original byte counts
and SHA-256 references; historical outputs reference the original callback rather
than repeat articles. The current training batch is separately bounded by the
same byte allowance and deduplicates GEPA's per-component repeated feedback.
`history_entries` and `history_bytes` bound the historical projection, not durable
storage. If mandatory summaries alone cannot fit, oldest rows are omitted with an
explicit count. These limits describe partial context; they never claim all text
was shown. Final upstream state is paired with proposal bookkeeping on completion;
exact resume restores rejected proposals and does not repeat completed work.
