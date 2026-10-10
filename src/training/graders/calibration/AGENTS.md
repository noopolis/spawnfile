# Pure grader calibration

Owns group exclusion/splitting, Platt fitting, held-out metrics and group bootstrap,
evidence bars, escalation planning/enforcement and independent teacher agreement.
The public seam is index.ts. No provider calls, filesystem labels, trial lifecycle,
or runtime imports belong here. Consumers supply verified golden records and identities.

Platt uses mean NLL plus 0.5*((a-1)^2+b^2), fixed lambda=1.0. Its shrinkage persists
at large sample sizes; arbitrary unregularized generating parameters are not recoverable.
Hash-ranked lineages split equally (odd remainder held out). Example exclusions remove
all revisions of the matching lineage before the split. Bootstrap draws whole lineages.
Retained group coverage means groups with at least one non-escalated instance; band
endpoints are inclusive. ECE with fewer than ten instances is conservatively 1 and
cannot pass evidence bars. Gate false-pass rate is conditional on golden bad instances.
Teacher fallback excludes golden answers contributed to by that teacher; callers may
rederive those answers from other labelers and then supply their independent provenance.
Agreement compares exact goldenAnswer and teacherAnswer options, including score integers;
good is retained only for evidence counts. Different acceptable options do not agree.

Verify with targeted Vitest tests/coverage, ESLint and TypeScript. Bound repair to three
rounds; stop at an unresolved root defect. No thresholds may be weakened to pass tests.
