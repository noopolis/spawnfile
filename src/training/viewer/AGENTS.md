# Local Training Viewer

Owns the future local live/replay experiment interface, separate from website/.

- Read persisted experiment projections through public contracts. The CLI remains
  usable without this UI; opening, refreshing or replaying cannot invoke cognition.
- Show candidate lineage/diffs, rule trees and matched evidence, lifecycle, coverage,
  train/validation/final-test results and separated usage without inventing data.
- Preserve sealed-test access and trace privacy. Display incomplete/stalled streams
  explicitly; never silently recompute old scores with new criteria.
- Group future UI by feature boundaries with focused guides and adjacent tests.
- Prove live/replay consistency and zero model calls on load/reconnect. No viewer
  code, framework configuration or executable build exists in this seed.
