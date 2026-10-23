# Native Codex adapter

Owns the pinned exec/resume JSONL protocol, explicit native instruction mapping,
external saved subscription selection and bounded process-group stopping.

- Consume public CLI behavior only. Never read/copy auth contents or infer tool calls from prose.
- Native JSONL is partial observation; a successful terminal frame does not prove tool-trace completeness.
- Resume only the exact thread returned by this trial. Never select a recent ambient session.
- Tests cover decoding, invocation controls and failure paths. Live conformance is separate from toy-process tests.

`environment.ts` owns saved authentication selection and isolated subject environments. `providers/codex-subscription/` owns standalone subscription inference; both enter the core through public contracts and externally registered factories.
