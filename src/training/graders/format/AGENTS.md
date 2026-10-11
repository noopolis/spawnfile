# Grader formats

Owns strict grader/label schemas, YAML and content-addressed file loading, and
canonical digests. Public seam: index.ts. No provider calls or runtime imports.
Gate check objects remain opaque except artifact-binding restrictions; callers
validate their evaluator semantics. YAML duplicate keys and unsafe map keys fail.
Sequence gates require a positive argument-to-binding equality conjunct in the
final predicate; a binding mention or bypassable Boolean branch is insufficient.

Run adjacent tests, ESLint, TypeScript and per-file coverage. Verify path-bearing
errors, content mismatches and unsupported scoring without invoking inference.

`abstain` is reserved in choice options because it is the vote abstention marker.
IDs/map keys reject prototype names; identifiers also reject control characters.
Human votes precede editor votes, then model consensus; conflicts within the highest
answering kind remain disputed. Editors declare a name and optional source description. Inline JSON is canonically hashed;
references verify exact bytes before JSON decoding (for .json) or UTF-8 text loading.

Golden labels accept a sidecar path or an inline labels body with implied grader.
Inline references resolve from the grader file without adding paths to digests.
YAML diagnostics show the first issue with line/column and a remaining issue count.

External label-import manifests admit human/editor declarations only and validate
declared context/labelers and unique vote coordinates before any golden write.
Imported human/editor IDs must not collide with any configured teacher ID.

Named models accept 1–4 unique IDs, mutually exclusive with legacy model syntax.
The public decisionModels/graderForModel seams normalize default routing.

Ollama models alone accept context_tokens: integer 2048..131072, default 16384.
