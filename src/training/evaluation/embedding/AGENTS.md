# Embedding Evaluators

Owns similarity metrics, reference bindings and calibration.

- Obtain vectors through an explicitly selected embedding capability in inference/.
  A subscription text CLI does not imply embeddings support.
- Pin model/version, reference digest, normalization, distance and thresholds.
- Similarity can measure relevance; do not present it as proof of factual truth.
- Reject incompatible dimensions, non-finite values and invalid scores explicitly.
- Test metric/calibration edge cases beside implementation and record backend
  integration provenance. Missing measurements remain unknown or explicit errors.
