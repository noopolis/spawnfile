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
