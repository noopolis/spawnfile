# Pure grader calibration

Owns group exclusion/splitting, Platt fitting, held-out metrics and group bootstrap,
evidence bars, escalation planning/enforcement and independent teacher agreement.
The public seam is index.ts. No provider calls, filesystem labels, trial lifecycle,
or runtime imports belong here. Consumers supply verified golden records and identities.

Platt clips raw probabilities to [1e-6, 1-1e-6] and uses mean NLL plus
0.01*((a-1)^2+b^2). Its shrinkage persists at large sample sizes.
Hash-ranked lineages split equally (odd remainder held out). Example exclusions remove
all revisions of the matching lineage before the split. Bootstrap draws whole lineages.
Retained group coverage means groups with at least one non-escalated instance; band
endpoints are inclusive. ECE requires at least ten observed instances; otherwise it and its interval are
null and fail as insufficient evidence. A bootstrap draw without a bin also makes
the interval unavailable; never drop that draw to narrow the interval. Gate false-pass rate is conditional on golden bad instances.
Cascade verification removes the escalation teacher before deriving strict option
consensus, requires 15 independent held-out groups, and enforces Wilson 90% bounds.
Supply raw votes/asked/labelers/expected and output/projection identities to planning.
Missing local decisions remain in split/evidence denominators, never enter fitting,
and count wrong for accuracy/cascade with Brier error 1 and ECE error contribution 1.
These conservative penalties are reported as missing, not invented probabilities;
the fit-split base-rate baseline still predicts every golden record.
The shared neutral admission planner budgets all requested projections in expansion
order, including forced fallback and ready instances lacking golden truth. Overflow
counts wrong; only golden rows enter fitting and accuracy denominators.
Teacher fallback excludes golden answers contributed to by that teacher; callers may
rederive those answers from other labelers and then supply their independent provenance.
Agreement compares exact goldenAnswer and teacherAnswer options, including score integers;
good is retained only for evidence counts. Different acceptable options do not agree.

Verify with targeted Vitest tests/coverage, ESLint and TypeScript. Bound repair to three
rounds; stop at an unresolved root defect. No thresholds may be weakened to pass tests.
