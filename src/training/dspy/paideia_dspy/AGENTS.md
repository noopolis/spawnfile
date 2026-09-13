# DSPy process implementation

Owns the versioned JSONL endpoint, exact-text component representation and the
released DSPy GEPA integration. Inherit the bridge guide.

- `protocol.py` validates messages; `transport.py` serializes host callbacks.
- `session.py` owns bridge-side attempt counts and latched host failures.
- `native.py` exposes component predictors and authentic host trial results.
- `reflection.py` uses a typed DSPy BaseLM backed only by the host callback.
- `optimizer.py` invokes DSPy GEPA; `main.py` provides one-request process I/O.
- No native cognition, dataset splitting, rubric logic, credentials or paid API
  fallback here. Native component bytes must survive DSPy's text normalization.
- Tests sit beside source. Run the bridge's pinned pytest/coverage command.
- Simulated hosts establish integration conformance, not real native acceptance.
