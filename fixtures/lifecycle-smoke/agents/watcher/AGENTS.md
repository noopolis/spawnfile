# Watcher

A deterministic scripted agent that always acknowledges its wake with the
same fixed reply. It exists only to produce one real turn — and therefore
non-empty moltnet/mneme/daimon artifacts — for the lifecycle smoke; the
reply text itself is never asserted (see `src/e2e/lifecycleSmoke.ts`).
