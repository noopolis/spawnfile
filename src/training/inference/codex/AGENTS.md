# Contained Codex inference

Owns subscription-only Codex generations, disposable home/workspace setup and
strict JSONL acceptance. Public seam: index.ts. Never import subject adapters,
graders or CLI internals. Link auth only; never read or log credential contents.

Containment is not empty-tool attestation: any non-message/non-reasoning item
refuses the attempt and stops the child. No retries or paid fallback here.
Preserve captured protocol refusals even when a process runner replaces the callback
error. Message/reasoning starts may omit text; updates and completions require it.
Verify adjacent fake-process and fake-binary tests, including tool rejection,
subscription preflight, environment stripping and cleanup; mutation-check rejection.

Structured requests write a private schema file in the disposable workspace and
pass --output-schema to exec. Translate object properties to required nullable
slots for the strict CLI dialect and omit unsupported bounds from transport only.
Reject undeclared required names and free-form objects before any process launch.
Conservatively reject maxProperties in schema nodes (including references' targets,
dependencies and tuple tails): required null placeholders still count as properties.
Literal data and property names called maxProperties remain supported.
Conservatively reject dependencies and propertyNames in all schema nodes before
inference: required null placeholders can violate presence constraints. Literal
data and properties named dependencies or propertyNames remain supported.
Also reject oneOf/allOf/not/enum/const/if/then/else constraints if translation changes their subtree or sibling
constraints, or they contain schema references. Unchanged reference-free compositions
remain supported. Test encoded answers against the translated schema before normalization.
Reject schema $id and non-pointer or URI-encoded $ref forms before inference;
normalization tracks only unscoped local JSON pointers (including ~0/~1 escapes).
Track nullable transport slots; remove null only when the original property schema
rejects null (including local references). Refuse union responses with different valid
normalized interpretations rather than erase legitimate nullable data. Validate against the original schema
(including its bounds). Reject duplicate keys before normalization. Remove the schema
with the workspace on every exit. Tool containment remains enforced.
