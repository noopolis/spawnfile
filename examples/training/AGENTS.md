# Authoring Examples

Owns readable integration examples used to refine Paideia's YAML authoring surface.
These are draft YAML/native declarations with Markdown explanations, separate from
implemented task corpora in evals/.

- Group examples by project or coherent scenario family, with one overview README.
- Keep one README with native source/environment files and inline-record datasets.
  Do not require agent/runtime/experiment YAML or case-per-file layouts. Reference
  external project inputs; do not copy private corpora, credentials or runtime state.
- Mark proposed fields and missing fixtures explicitly. YAML syntax acceptance is
  not schema validation, adapter support or evidence of a successful agent run.
- Keep each document focused and under 400 lines. Add nested guides and CLAUDE.md
  symlinks as responsibilities grow; inherit the root development rules.
- Verify relative Markdown links, YAML syntax and existing source references.
- Example YAML and native declarations are authorized; product implementation stays
  paused until authoring approval. Do not mount evaluator-facing examples, rubrics
  or held-out answers into subject workspaces.
