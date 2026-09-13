# Local Training Viewer

Owns the local live/replay experiment interface, separate from website/.

- Read persisted experiment projections through public contracts. The CLI remains
  usable without this UI; opening, refreshing or replaying cannot invoke cognition.
- Show candidate lineage/diffs, rule trees and matched evidence, lifecycle, coverage,
  train/validation/final-test results and separated usage without inventing data.
- Preserve sealed-test access and trace privacy. Display incomplete/stalled streams
  explicitly; never silently recompute old scores with new criteria.
- Group future UI by feature boundaries with focused guides and adjacent tests.
- `startViewer` serves the caller's phase-filtered `ViewerData` projection over
  loopback HTTP. It imports no trial, inference or storage implementation.
- `projectTrials` and `projectTrainingReport` consume public experiment types and
  scoring only. They expose recorded identities, verdicts, evidence references,
  coverage and usage; omit prompts, outputs, tool payloads and judge reasons.
  GEPA lineage links recorded validation captures to native candidate identities.
- `projection.ts` strips undeclared fields and bounds arrays, bytes and check
  depth. Callers must redact summary text and filter sealed phases before load.
- `page.ts` renders escaped local HTML/SVG and refreshes with GET only. Supplied
  scores and usage are displayed without aggregation or inferred completeness.
- `costs.ts` projects supplied estimates and recorded valuations to named roles,
  model attribution, outcomes, bounded token counts and dated HTTPS price sources.
  Never expose raw reports, call IDs, error text, legacy evidence or sealed content.
  Display capture coverage separately from pricing completeness; subscription
  charges stay separate. Cache reads/writes are input subsets, reasoning is output.
- Test actual HTTP responses, refreshed snapshots, hostile strings, read-only
  methods, generic loader errors and shutdown. Run `npx vitest run viewer`;
  include viewer coverage and lint at the final gate.
