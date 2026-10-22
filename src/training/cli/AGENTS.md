# Command Interface

Owns explicit local commands, configuration selection and human diagnostics.

- Keep commands thin; experiment, evaluation and optimization behavior belongs
  in their owning modules, not duplicated argument handlers.
- Grader commands delegate to the grader feature entry point. Standalone grading
  binds named local context files; absent trial evidence remains unknown.
- Native grader routes are built before subject construction, matching frozen
  grader/calibration digests. Training requires exclusion digests for both source
  datasets; internal validation conservatively excludes the whole training file.
- `main(argv, io, dependencies)` validates, evaluates, trains or views through public
  module exports. Native/inference boundaries alone are injectable in tests.
- Explicit Markdown selections map to identical native paths. Resources remain
  locked unless a train invocation selects `--editable`; unsupported native
  configuration, skills or preparation profiles fail rather than approximate.
- `--max-trials` includes two conservative sealed-test passes; training's
  `--experiment-timeout-ms` (legacy `--timeout-ms`) bounds the command, separately
  from `--trial-timeout-ms`, inference routes, broker turns and extraction. A training report is stored under a test-role summary
  manifest bound to the frozen selected candidate, never an optimizer-readable run.
- Resolve population trial defaults after dataset loading, identically in dry-run
  and execution. Count baseline plus every round's variants on train/validation,
  and two test passes. Explicit CLI/YAML caps override this derived default.
- The local invocation index contains references and identities only. Blob/report
  access still uses storage authorization. Failed attempts publish a failure index
  bound to the baseline and a development-only viewer projection. Raw partial
  evidence keeps its original permissions; failure replay never releases sealed tests.
- `view OUT_DIRECTORY` validates the saved invocation and serves its projection
  on loopback until cancellation, with no implicit deadline. An explicit
  `view --timeout-ms` still bounds its lifetime. `--view PORT` serves persisted presentation
  snapshots during train/evaluate. Pages never launch work or write evidence.
  Live projections omit test identities until selection freezes; completed replay
  uses the explicit invocation's frozen candidate and operator access.
- `launch.ts` owns process signals and exit status. `main.ts` is the executable shim.
  Run adjacent tests, CLI process tests and real DSPy through injected subject
  callbacks; those tests do not claim subscription/native-agent acceptance.
- Surface unsupported capabilities, missing credentials, incomplete observations
  and real terminal outcomes plainly. Exit zero requires the intended artifact.
- Never start deployment, publication or paid API fallback implicitly.
- Group commands by cohesive feature as the surface grows; retain named entry
  points and adjacent parsing/behavior tests.
- Test invalid inputs, cancel/error exit behavior and positive output artifacts,
  not just whether a child process launched.

Native grader-file dispatch accepts both calibrated and atomic schemas. Atomic routes
freeze definition/template digests and do not claim calibration exclusion evidence.

Completed optimizer training exports REPORT.md/REPORT.json and immutable candidate
bundles through report/index.ts after sealed completion. The invocation index
references the immutable snapshot. Never export failed or in-progress held-out
evidence; export errors prevent completion. Comparison keeps its existing report.
Stored viewer replay accepts optional export references without reading export files;
older invocations remain valid and malformed or unknown index fields still fail.

Real GEPA regression coverage must verify rejected candidate files/patches,
round attribution and successful completed resume without new native trials.

Explicit --validation datasets flow through execution, costs and repair without repartitioning; groups and explicit validation cannot compete.

Invocation report blobs externalize atomic grading through storage's JSON codec.
Viewer reads hydrate after summary blob authorization; missing/corrupt detail
fails closed. Operator REPORT.md/REPORT.json exports consume the full inline
report and preserve scores/evidence. Legacy inline report blobs remain readable.

Fixed graders with explicit identity calibration have no labeled corpus and need no
calibration exclusions. Keep definition/mode digests and dataset split guards intact.
