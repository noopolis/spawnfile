# Case Resolution

Owns readable YAML tasks, references, suite resolution and dataset plans.
The authoring language is still under discussion; do not invent runnable syntax.

- Keep cases runtime-neutral; native commands and credentials belong elsewhere.
- Validate unique keys, references, unknown fields, resource limits and cycles.
- Preserve source locations and the resolved plan's identity for diagnostics.
- One dataset YAML contains inline records. The invocation binds train/test roles;
  validation may partition training groups. Reject evidence-family leakage, not just
  duplicated paragraphs. Do not require per-case YAML or auxiliary authoring manifests.
- Task corpora live in evals/ or external projects. Parser tests and malformed
  fixtures stay beside their implementation here.
- Test both accepted authored cases and rejection paths once the schema is agreed.
