# Teacher labeling plans

Owns pure projection grouping, teacher prompt/schema construction, vote decoding
and deterministic adjudication selection. Public seam: index.ts. Never import
runtime providers or CLI code. Label file IO and subscription invocation belong
to CLI grader runners. Run adjacent tests and per-file coverage; stale vote and
projection isolation guards require negative tests.
