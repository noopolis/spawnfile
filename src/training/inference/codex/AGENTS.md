# Contained Codex inference

Owns subscription-only Codex generations, disposable home/workspace setup and
strict JSONL acceptance. Public seam: index.ts. Never import subject adapters,
graders or CLI internals. Link auth only; never read or log credential contents.

Containment is not empty-tool attestation: any non-message/non-reasoning item
refuses the attempt and stops the child. No retries or paid fallback here.
Verify adjacent fake-process and fake-binary tests, including tool rejection,
subscription preflight, environment stripping and cleanup; mutation-check rejection.
