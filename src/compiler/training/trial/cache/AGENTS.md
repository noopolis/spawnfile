# Trial and judgment cache

A trial that was already measured is not run again: its recorded answers are replayed.
The cache lives outside any run (`<spawnfile home>/training-cache` by default) and survives runs.

- `digest.ts` keys a trial. `compiledAgentDigest` hashes every file of the compiled trial
  organization (the prompt, every workspace file, skills, MCP tools, the Dockerfile with its
  runtime pins, the model and effort in the runtime config), with only what names the trial or
  the project's location normalized out: the trial slug, volume lineage hashes, the team resource
  directory and the compile fingerprint label. Compile reports are left out. `trialBaseKey` adds
  the moment (fills by content revision, never by host path); `trialWakeKey` adds the first wake's
  text and deadline. Bump `TRIAL_CACHE_VERSION` when what a cached trial means changes.
- `store.ts` keeps entries at `trials/<base>/<wake>/<n>/` (`entry.json`: every wake result, every
  output read after each wake, the teardown failure; `evidence/`: the trial's evidence directory).
  Each run has a claims ledger in its output (`booted-trials/trial-cache-claims.jsonl`): an entry
  counts once per run, so repeats (validation or test repeats) are distinct trials, and a resumed
  run never counts an entry twice. A fresh trial is claimed for its own run when recorded.
- `session.ts` wraps one trial. Mode `reuse` (default): a never-recorded agent and moment boot at
  once, exactly as without a cache; otherwise the first wake picks an unclaimed identical entry and
  replays it (nothing builds or boots, the prepared trial is discarded), or boots then. Mode `fresh`
  never replays and still records; `off` does neither. Only clean trials are recorded: every wake
  completed or deferred by the subject's own choice, and no teardown failure. A replayed wake carries
  `reusedFrom` (the measuring trial), which reaches the report's Source column; its evidence
  directory receives the original evidence plus `reused-from.json`.
- `judgments.ts` keeps valid judge replies at `judgments/<key>/<n>.json`, keyed on the judge
  engine, model, effort and the whole wake text (article, question bank, schema) plus the judge
  instructions. The n-th identical request of a process reads the n-th reply, so questionnaire
  repeats stay separate samples. A grader change changes the text and is judged again without new
  trials. Optimizer proposals use it under their own key only in `reuse` mode, so an unchanged
  rerun (or a rerun after a crash) repeats the whole search without a new subject trial; `fresh`
  asks the optimizer again.

The Daimon adapter test `trialCache.test.ts` drives its real launcher with a fake compile and must fail if a changed
prompt or skill file is served from cache.
