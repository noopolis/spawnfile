# Documentation Guide

These documents explain approved architecture and development decisions. Research
evidence stays in research/; user-facing pages belong in website/.

- Keep one canonical account of each contract; link instead of copying it across
  guides. Mark illustrative syntax and unresolved choices explicitly.
- Describe working behavior only after observing it. Do not document commands,
  lint guarantees or successful optimization as implemented before they exist.
- Architecture diagrams show ownership and data movement. Use the arrow-diagram
  skill for ASCII flow diagrams and keep them compact enough for Markdown.
- Group growing references by subject when navigation becomes difficult; add
  focused AGENTS.md and CLAUDE.md pairs in new maintained subdirectories.
- Check local links and examples against the actual source or proposal they cite.
  Prose edits need no synthetic evaluator or review-council machinery.

The training-report-export spec owns local artifact layouts, evidence labels and
uncertainty semantics. Keep reports operator-local and distinguish end-of-run
round-grouped candidate summaries from measurements taken during a round.

Training export documentation distinguishes original per-round measurements,
prior captures, later rescores, sealed results and unattributed legacy trials.
Rejected evaluated manifests and paid failure receipts survive completed resume.
