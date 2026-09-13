# Native Subject Adapters

Owns harnessing real subjects through public native CLI, SDK or service APIs.
No native adapter is implemented yet.

- Daimon, Codex, Claude Code, Pi, OpenClaw and other integrations are peers;
  external agents must not need a Daimon wrapper or a different case language.
- Accept existing project source paths and map candidate files into supported
  native instruction/skill mechanisms. Document prerequisites and unsupported
  mappings clearly; do not pretend every runtime uses the same Markdown loader.
- Declare capabilities and observation limits. Distinguish installed, loaded and
  followed resources; final prose is not proof of a hidden tool sequence.
- Keep preparation, native event decoding, cancellation and artifact collection
  together per implemented adapter. Add child folders only when code exists.
- Inference for DSPy and judges belongs in inference/, not the subject adapter.
- Native conformance tests belong with each adapter. Prove actual work, supported
  mappings and failure handling using pinned runtimes; toy processes test plumbing,
  not native-agent compatibility. First acceptance needs two independent harnesses.
