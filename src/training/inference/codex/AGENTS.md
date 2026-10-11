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
Remove optional null placeholders, then validate against the original schema
(including its bounds). Reject duplicate keys before normalization. Remove the schema
with the workspace on every exit. Tool containment remains enforced.
