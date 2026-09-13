# Host platform services

Owns shared host mechanics used by subject and inference integrations. No case,
evaluation, optimization or runtime-specific policy belongs here.

- Export focused public child entry points; do not collect unrelated helpers.
- Retain explicit bounds, cancellation outcomes and observable failure.
- Unit tests use real local processes where possible; vendor conformance belongs in adapters.
