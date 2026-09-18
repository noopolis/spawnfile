# Newsroom Evaluation Datasets

Owns train.paideia.yaml and test.paideia.yaml: one YAML per dataset, with inline records and named
fixtures. The parent README is the only walkthrough; inherit its project guide.

- Keep evidence selectors relative to their named native resource, never this folder.
- Selectors, hashes, record groups, prompts and criteria here are synthetic and must
  stay synthetic. A project's real paths and hashes belong in that project's repository.
- The native project is the parent Spawnfile; moving a dataset never changes the
  agent's working directory, source mapping or tool paths.
- This folder is evaluator-only. The parent's .spawnignore declares planned
  packaging exclusion; the current compiler does not implement that exclusion.
- Verify YAML syntax, source references and links. Do not add per-case files,
  extra configuration, live trials or another README.
