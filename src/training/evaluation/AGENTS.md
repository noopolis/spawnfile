# Evaluation Engine

Owns evaluator registration, execution and the shared result contract.

- Compose logic/, mechanical/, semantic/ and embedding/ through public interfaces.
  Categories are organizational, not a closed list of possible evaluators.
- Trusted custom TypeScript evaluators register schemas and capabilities; YAML
  cannot embed executable code. Untrusted plugins need an explicit boundary.
- Keep immutable evidence, cancellation and budgets available to evaluators.
- Separate subject event relationships from evaluator execution dependencies.
- Pass, fail, unknown, error and skipped remain distinguishable with evidence.
  Never hide incomplete coverage or let scores compensate mandatory gates.
- Test malformed evaluator output, unknown registrations, cancellation and versioned
  rescoring. A rescore cannot invoke the subject or count as another native trial.
