# Observable Capture

Owns normalization, provenance, completeness and artifact snapshot evidence.

- Preserve raw source identity, event IDs and correlation alongside normalized
  records. Unknown event types must not silently disappear into a complete trace.
- Dispatch, completion and durable effects are distinct. Never infer success from
  a tool name in prose or fabricate unavailable hidden reasoning/provider inputs.
- Capture immutable bytes and digests with provenance; storage owns persistence.
- Keep sensitive raw data separate from approved evaluation and viewer projections.
- Missing terminal output or truncated streams mean incomplete observation.
- Test partial/reordered/unknown events and artifact mutations. Capture failure
  must not turn into a successful absence assertion or zero cost.
