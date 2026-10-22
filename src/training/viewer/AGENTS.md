# Local Training Viewer

Owns the local live/replay experiment interface, separate from website/.

- Read persisted experiment projections through public contracts. The CLI remains
  usable without this UI; opening, refreshing or replaying cannot invoke cognition.
- Start with a compact visual cockpit: observed training/validation curves,
  paired candidate comparisons, gate results and known costs. Detailed rule trees,
  events and identities belong behind navigation and collapsed inspectors.
- `metrics/` owns pure numeric presentation. Average repeated trials within a
  case first; pair comparisons on matching case IDs. Display observed/expected
  coverage and missing values. Never average distinct stages into a new score.
- `cockpit/` follows Moltnet's console shell, panels and tokens. Keep the page
  inside 100dvh; long data panes own scrolling. Render only the selected metric
  and switch via a bounded same-origin GET, not all metric/row combinations.
- Preserve sealed-test access and trace privacy. Display incomplete/stalled streams
  explicitly; never silently recompute old scores with new criteria.
- Group future UI by feature boundaries with focused guides and adjacent tests.
- `close(finalSnapshot)` sends the last persisted projection as a terminal SSE
  shell before closing connections. Bound stalled writes, stop pending polls and
  never rely on a post-shutdown GET or a grace sleep. Clients reject stale GETs
  after the terminal frame; all final HTML uses the same projection and escaping.
- `startViewer` serves the caller's phase-filtered `ViewerData` projection over
  loopback HTTP. It imports no trial, inference or storage implementation.
- `projectTrials` and `projectTrainingReport` consume public experiment types and
  scoring only. They expose recorded identities, verdicts, evidence references,
  coverage and usage; omit prompts, outputs, tool payloads and judge reasons.
  GEPA lineage links recorded validation captures to native candidate identities.
  Carry the authored deferred-scoring policy into live, completed and failed
  projections so displayed optimizer rewards match the supplied training policy.
- `projection.ts` strips undeclared fields and bounds arrays, bytes and check
  depth. Callers must redact summary text and filter sealed phases before load.
- `page.ts` delegates escaped HTML/SVG to the cockpit. Charts distinguish raw
  metrics from gated reward; no smoothing, invented points or inferred convergence.
- `costs.ts` projects supplied estimates and recorded valuations to named roles,
  model attribution, outcomes, bounded token counts and dated HTTPS price sources.
  Never expose raw reports, call IDs, error text, legacy evidence or sealed content.
  Display capture coverage separately from pricing completeness; subscription
  charges stay separate. Cache reads/writes are input subsets, reasoning is output.
- Test actual HTTP responses, refreshed snapshots, hostile strings, read-only
  methods, generic loader errors and shutdown. Run `npx vitest run viewer`;
  include viewer coverage and lint at the final gate.

Authored comparison projections name two frozen arms and reuse existing measured
trends/pairing. They have no optimizer provenance or GEPA panel. Candidate labels
are escaped presentation text; scores and held-out visibility retain their existing
owners. Failed comparisons show development-only partial measurements.
