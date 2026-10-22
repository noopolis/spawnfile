# Native formatting experiment

This small example trains a native agent to turn `Token: Alpha` into `ack:alpha`.
The intentionally incorrect baseline copies `Alpha` unchanged. It tests whether
real DSPy optimization can revise a declared Markdown instruction and improve an
unseen token through the same native execution interface.

```text
native-formatting/
├── SOUL.md                 locked identity, passed as native instructions
├── PROMPT.md               editable instruction, passed as native instructions
└── evals/
    ├── train.paideia.yaml  Alpha training + Beta internal validation
    └── test.paideia.yaml   Gamma sealed comparison after selection freezes
```

Each record adds an exact expected output to the identical shared shape check.
The expected answers and datasets remain outside the native workspace. The
invocation selects `beta-validation` as its internal validation group; filenames
alone do not grant or deny access. Validation returns only scores to DSPy; test
records run after the selected candidate is frozen.

The source mappings are `SOUL.md` → native `SOUL.md` (locked) and `PROMPT.md` →
native `PROMPT.md` (whole-file editable). Both resources are explicit instructions;
the adapters disable ambient instruction discovery. Each trial installs a fresh
immutable candidate copy. The example source files remain unchanged.

Native acceptance uses `trainAgent`, `runStoredTrial`, `snapshotCandidate` and
`openExperimentStore` from their public module entry points. Real `dspy.GEPA`
receives bounded native Codex trial callbacks and Claude subscription reflection.
The frozen baseline and selected prompt are also tested through native Daimon.
No API-key fallback, production organization, memory fixture, Moltnet transport,
native skill discovery or claim of general writing improvement is involved.

The local acceptance run on 2026-09-13 completed through the public APIs on its
first attempt. Real DSPy 3.3.1 / GEPA 0.1.4 made six metric calls and one proposal,
within an eight-call / two-proposal budget. Reflection used the saved Claude
subscription with reported model `claude-fable-5-1`.

| Native held-out Gamma trial | Baseline | Frozen selected candidate |
| --- | --- | --- |
| Codex `gpt-5.6-luna` | `Gamma` — fail | `ack:gamma` — pass |
| Daimon `gpt-5.5` | `Gamma` — fail | `ack:gamma` — pass |

Both source hashes and the locked SOUL bytes remained unchanged. All four held-out
captures replayed with identical mechanical evaluation results and no additional
native or inference calls; the 55 persisted store files stayed byte-identical.
Optimizer access to each test capture was rejected.

| Observed route | Input tokens | Cached input | Output tokens |
| --- | ---: | ---: | ---: |
| Codex, eight native trials | 99,968 | 39,168 | 102 |
| Daimon, two native trials | 25,494 | 13,312 | 35 |
| Claude reflection, one generation | 5,858 | 0 | 347 |

Counts are the native routes' reported fields; unreported reasoning usage remains
unknown. One token per split is a working integration proof, not a statistical
estimate of generalization or subscription consumption.

Receipts remain local in `.runtime/native-training-proof/attempt-1/`:
`acceptance.json`, `training.json`, `verification.json`, and the immutable store.
The acceptance receipt digest is
`sha256:3756449521a825a4c884b019436ae9fc689552b5e5a875ccc3bb0b07cc041188`.
