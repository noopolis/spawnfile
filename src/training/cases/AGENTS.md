# Case Resolution

Owns readable YAML tasks, references, suite resolution and dataset plans.
The authoring language is still under discussion; do not invent runnable syntax.

- Keep cases runtime-neutral; native commands and credentials belong elsewhere.
- Validate unique keys, references, unknown fields, resource limits and cycles.
- Preserve source locations and the resolved plan's identity for diagnostics.
- Keep explicit train/validation/test manifests; reject split leakage according
  to declared evidence-family policy, not random paragraphs alone.
- Task corpora live in evals/ or external projects. Parser tests and malformed
  fixtures stay beside their implementation here.
- Test both accepted authored cases and rejection paths once the schema is agreed.
