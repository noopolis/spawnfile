# Teacher labeling plans

Owns pure projection grouping, teacher prompt/schema construction, vote decoding
and deterministic adjudication selection. Public seam: index.ts. Never import
runtime providers or CLI code. Label file IO and subscription invocation belong
to CLI grader runners. Run adjacent tests and per-file coverage; stale vote and
projection isolation guards require negative tests.

Compact provenance stores call receipts once and per-vote call references plus
question digests. Resolve both compact and legacy receipts through voteProvenance;
missing references, stale policies and mismatched projections refuse reuse.

Human and editor votes require current question and projection digests too; only teacher
policy checks are exempt. Changed meaning/evidence requires re-adjudication.
