# Local training report export

Completed optimizer training (`paideia.training.v1`) writes `REPORT.md` and
`REPORT.json` in the command output. This includes completed runs whose selected
candidate fails quality checks. Failed/interrupted attempts, evaluation-only runs,
legacy untyped reports and fixed authored comparisons retain their existing
protected reports and do not create a completed optimizer export.

The invocation index's optional `trainingExport` points at an immutable
`training-report-<uuid>/` snapshot. Resume creates another snapshot; root reports
are the latest convenience companions. No publication or source deployment occurs.
Files use mode 0600, directories 0700. Candidate filenames retain the baseline's
validated source-relative paths under `candidates/<label>/files/`; each candidate
has a manifest and a `baseline.diff`. Baseline and every evaluated candidate are exported, including rejected GEPA
proposals absent from final optimizer provenance. Stored native reports retain the
exact evaluated manifest so completed resume exports the same bundles. Unchanged patches are
empty. Patches preserve final-newline and CRLF differences and apply to baseline
source files with ordinary `git apply`. Diffs also appear in Markdown.

JSON uses `paideia.training-export.v1`: selected/baseline identities, candidate
manifests, split/example measurements, optimizer round provenance, failing-check
rows and summaries, paired held-out differences, duration, request accounting,
existing cost receipts and cost plan. The original complete training envelope
remains in its protected content-store blob. Export write or readback failure
prevents publication of a successful invocation index.

Scores use the same public `trialScore` as training, including execution/closure
gates and behavioral zeros. Latest rescores replace final scoring measurements,
retain original capture IDs and remain distinct from independent native trials.
Live and per-turn checks retain their original measurements. Missing or unscorable
examples stay null; complete split means require every declared example. A partial
observed mean is labeled separately. Repeated trials are averaged within examples,
then examples receive equal weight. No selection or grading runs during export.

Native optimizer callbacks record their actual search round before execution:
population seed round zero and each declared round, or GEPA seed zero and its
upstream iteration-start event. Stored reports and callback journals retain this
attribution through replay/resume. Round rows aggregate only original native
measurements recorded in that round, with per-example measurements in JSON.
Separate `availableThroughRound` train/validation summaries include attributed
prior captures. Unrun cells remain null. Test measurements are post-selection and
never enter search rows. Later rescores replace final split scores, but cannot
retroactively change original round measurements. Rescore timing is not attributed
to search rounds; an original failed measurement therefore remains unknown there.
Legacy search trials without round IDs remain explicitly unattributed; their final
split scores are still exported without inventing a trajectory.

Held-out comparison pairs the baseline and frozen selected candidate by example.
Incomplete pairs produce no overall difference claim. Two or more complete pairs
include sample standard deviation and standard error of between-example deltas;
these descriptive estimates assume independent examples, are not confidence
intervals, and do not measure stochastic repeat variability. One paired example
has unknown sampling uncertainty. The exporter never changes the selected ID.

Trial `durationMs` measures host elapsed time through preparation, native work,
final evaluation and closure before final report persistence/scratch cleanup.
Training `durationMs` measures the current invocation, including restore work and
sealed tests. Missing historical timings stay null. Parallel trial times are not
summed as elapsed time. Judge/optimizer counts come from recorded cost entries;
subject turns and token observations are not model requests. Unobserved native
HTTP calls and total model requests remain unknown.

Judge counts include paid decision requests from `grading.decisionAccounting`
and failed-grade `EvaluationResult.decisionAccounting`. The grader evaluator catches
its typed accounting failure while retaining gate evidence; it produces an error,
never a fabricated grade. Replay validates and retains the same receipt schema on
success and failure, including drift responses and exhausted HTTP retries.
Each receipt is retained in a cost entry, including unknown-cost failed attempts;
its originating requestId identifies the dispatched attempt, including retries.
Named check references, plan copies and selective repairs retain that identity
and count it once across measurements. Fresh checks, trials and full rescores
dispatch fresh IDs even when their amounts and receipt contents otherwise match.
The builtin engine retains backend billing capabilities; grading success and
failure accounting and persisted result schemas preserve requestId. Injected
backends omitting IDs receive them once before invocation accounting is retained.
Older training envelopes receive missing decision entries during export without
repricing their other costs. With receipts alone, optimizer/subject counts and
overall cost completeness remain unknown. Legacy receipts without requestId use
measurement/check/ordinal identity for compatibility; cross-evaluation reuse
cannot be established for them from identical amounts or contents. New export
does not retroactively invent identities for historical captures.

Failure rows also traverse `grading.gates`, retaining each non-pass gate's authored
ID and verdict under `<check>/grading/gate/<id>`. Semantic gates are independent of
evaluation children. Latest rescores supply final gates; live/turn gates remain
the original measurements.

Costs retain existing call-level usage, API-equivalent ranges, known subtotals,
price/coverage completeness and warnings. Unknown prices remain unknown; actual
subscription/billed charges are never inferred. Fidelity identifies native trials
versus rescoring, execution state, capture closure, observation coverage and
adapter-declared isolation. Historical reconstruction fidelity remains unverified;
a successful native closure cannot prove a trial ran at the intended real moment.
Decision receipts' recorded usage-priced USD contributes to known subtotals.
Null receipt USD stays unknown; estimated USD remains separate admission evidence.

Adjacent export tests validate artifacts and permissions, immutable resume,
failed-attempt non-release, frozen selection, incomplete means, rescore identity,
paired uncertainty and byte-applicable patches. CLI acceptance uses the real DSPy
bridge with deterministic native/inference fixtures; it establishes integration,
not historical/native-agent fidelity or live model improvement.
