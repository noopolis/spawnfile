# DSPy process implementation

Owns the versioned JSONL endpoint, exact-text component representation and the
released DSPy GEPA integration. Inherit the bridge guide.

- `protocol.py` validates messages; `transport.py` serializes host callbacks.
- `session.py` owns bridge-side attempt counts and latched host failures.
- `native.py` exposes component predictors and authentic host trial results.
- `reflection.py` uses a typed DSPy BaseLM backed only by the host callback. Its
  model response decoder may unwrap one whole JSON fence; never loosen JSONL
  transport parsing or alter replacement text to recover a model envelope.
- `optimizer.py` invokes DSPy GEPA; `main.py` provides one-request process I/O.
- No native cognition, dataset splitting, rubric logic, credentials or paid API
  fallback here. Native component bytes must survive DSPy's text normalization.
- Tests sit beside source. Run the bridge's pinned pytest/coverage command.
- Simulated hosts establish integration conformance, not real native acceptance.

- `checkpoint.py` pairs upstream GEPA state with this session's exact callback
  sequence and upstream epoch sampler/RNG state. Never substitute optimizer replay
  from scratch or accept an unpaired upstream pickle. Checkpoint bytes are trusted
  evaluator state; they are not an import format for agent-produced artifacts.
- Resume reuses the original seed validation, because upstream invokes it before
  loading its state. Host callbacks following the saved boundary replay only if their
  exact identities match. Recovery attempt offsets are host-owned accounting, never
  optimizer feedback or newly generated trials.

- `proposal_history.py` mechanically projects train-only callback history and
  proposal metadata into bounded reflection context. It never scores outputs or
  summarizes through another model. Preserve full source records and explicit
  omission/excerpt metadata; numerical criterion results take priority over prose.
- Benign duplicate/novelty exhaustion uses GEPA's skip seam and stops the session;
  it must not latch a provider failure or launch duplicate native trials. Pair the
  upstream final state save too: GEPA omits the final state-saved callback.

- An explicit checkpoint fork verifies the exact parent optimizer bytes and old
  request/execution identity, imports paired state under the new identity, and
  commits parent lineage before callbacks. Parent directories remain read-only.
  Child resume requires the same lineage; importing never resets callback IDs,
  completed outcomes, sampler state or attempt budgets.

Protocol v2 uses one locked whole-line writer and one response reader dispatching
by callback ID. Session locks protect reservations/bookkeeping, never host calls.
Replay IDs use request content plus occurrence counts, saved explicitly with the
paired checkpoint, rather than deriving a sequence from completed-result count.
- `search/` owns opt-in population rounds, behavioral novelty and bounded retention.
  Omitted search dispatches to the unchanged released GEPA invocation. The search
  package reconstructs state by settled host-journal replay, without pickle; failed
  or uncertain recovery offsets and population forks fail closed before callbacks.
  `Evaluator.evaluate_many` preserves request order and bounds active evaluations
  by request.concurrency for both training feedback and validation.
