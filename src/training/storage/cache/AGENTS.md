# Persistent evaluation cache

Owns exact successful judge-response storage through openJudgeCache. No inference,
subject execution, score computation or provider selection belongs here.

- A host-protected root and explicit calibration namespace are required. The host
  binds frozen dataset and phase identities to requests and denies subjects access.
- SQLite transactions publish complete entries and serialize independent processes;
  operating-system locks release on exit. No guessed stale-lock recovery.
- Verify schema and the digest binding namespace, key and response/provenance on
  every hit. Corruption fails closed. Hashes detect alteration, not an adversary
  who controls this trusted host root and can recompute them.
- First successful exact response wins. Failed infrastructure judgments cannot be
  cached; legitimate failing quality grades can. Hits retain original attempt IDs
  but never create current inference calls, usage or native-trial evidence.
- Bound retained entries and serialized payload bytes. Evict oldest insertion;
  cache use does not imply independence or silently recalibrate a model alias.
- Test real reopen/process boundaries, concurrency, corruption, isolation and
  eviction. Preserve inherited per-file coverage and source-size limits.

Persist either strict citation judgments or evidence-ID judgments, never a hybrid.
Evidence-ID storage validates current unit-ID syntax, uniqueness, and bounded
reasons/IDs; membership in the exact selected source packet stays with the semantic
evaluator and is revalidated on hits. Keep raw responses and source-call attribution
unchanged. Storage imports contracts only, not evaluator implementation modules.
Grader-origin judge calls retain explicit billing route and measured wall milliseconds.
Unknown billing values and negative/nonfinite timing are rejected by the strict schema.
