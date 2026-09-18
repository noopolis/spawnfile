# Newsroom Dataset Example

Owns an illustrative Spawnfile/environment, evals/train.paideia.yaml,
evals/test.paideia.yaml, the proposed .spawnignore policy and one README.
Both datasets follow docs/authoring.md and contain their records inline.

- Keep the authoring surface small. Do not reintroduce case-per-file manifests,
  agent.yaml, runtime.yaml or experiment.yaml as mandatory authoring files.
- Every name, repository, revision and hash here is synthetic. Do not copy a real
  corpus, real agent prompts, real story identifiers or real evidence into this
  example; a project's own data stays in that project's private repository.
- Keep the shape realistic: resource/path/hash selectors, native workspace paths
  and one YAML per dataset. Every isolation or emulation difference must be visible.
- Example YAML/native declarations are authorized; product implementation, live
  trials, optimization and deployment remain outside this authoring task.
- Keep evaluator material and future outputs outside every subject access path.
  The .spawnignore file records the agreed packaging shape; Spawnfile does not yet
  enforce it. Keep that limitation explicit and do not launch a bare trial.
- README.md is the only walkthrough. Other Markdown is native prompt source or
  contributor guidance; do not inject contributor instructions into the subject.
- Check YAML structure, selector shape, guide links and native declaration
  validation. Claims require observed evidence.
- Keep files under 400 lines; larger corpora split into coherent named datasets,
  each still one YAML, not arbitrary numbered fragments or one file per case.
