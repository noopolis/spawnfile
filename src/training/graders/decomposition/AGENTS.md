# Atomic decomposition and templates

Owns strict atomic-unit/template formats, evidence-bound extraction validation and
pure deterministic check instantiation. Public seam is index.ts. Depend only on
runtime-neutral grader format APIs; never import inference, CLI or sibling internals.
Whitespace normalization may reconcile layout, never invent text. Rejected spans
and missing state remain observable. Persist rejected units and reasons; each stored
rejection instantiates one missing check. Unit paragraph/sentence indices are zero based.
Validation locates normalized spans; unique matches override hints, and ambiguous
occurrences require consistent hints. The public locateUnit resolver also returns
the raw source character offset for occurrence identity; offsets are recomputed,
not extractor hints or persisted unit fields. Body citations derive from runtime segments
under declared row patterns and leading-citation policy; disagreements are reported.
Location-scoped templates report exclusions through instantiateChecksReport. Source spans must occur in cited rows; drop and report invalid hints without rejecting verified units.
Drop and report fields absent from unit text; missing applicability fields create
missing checks. Extraction accepts strict JSON, optionally one surrounding json
fence, and exports the strict provider response schema.
Assignment obligations read contexts explicitly marked role: assignment (the name
assignment also works). Template criteria are answer-to-description maps; score
keys are integer strings; noul keys are true and false. Trap intent is operator
configuration under template.traps; no question wording is interpreted as truth.
Run the adjacent Vitest tests, TypeScript and ESLint checks; mutation-check span
verification. Keep each source/test under 400 lines and coverage above 90%.

Criteria cannot use reserved missing, abstain, uncertain or unchanged labels.
