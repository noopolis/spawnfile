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

atomic-graders.md is the canonical executable atomic grader-file specification.
Distinguish uncalibrated probabilities, admission estimates and live-trial fidelity.
Document applicability exclusions separately from missing extraction, and keep
assignment evidence access aligned with authored obligation kinds.
Keep backend preflight limits and terminal payment-error semantics explicit.

Describe exhausted atomic spend caps and rejected API requests as unscorable infrastructure errors under either missing policy; retain typed reasons without inventing request receipts.
Acceptance-gate infrastructure errors remain unscorable before extraction, with
their gate identity retained through replay and no fabricated atomic grade.

The training-report-export spec owns local artifact layouts, evidence labels and
uncertainty semantics. Keep reports operator-local and distinguish end-of-run
round-grouped candidate summaries from measurements taken during a round.

Training export documentation distinguishes original per-round measurements,
prior captures, later rescores, sealed results and unattributed legacy trials.
Rejected evaluated manifests and paid failure receipts survive completed resume.
Failure-row identities follow the producing measurement: retained native evidence
keeps its trial ID, while rescored final evidence uses the latest rescore ID.

Training configuration documents explicit validation and the generic named moment preparation receipt; org state reconstruction remains integration-owned.

Population search documents complete candidate development measurements, reuse of
unchanged parents, frozen sealed comparison and bounded public atomic feedback.
Keep real-bridge/fake-subject verification distinct from live native acceptance.
Document case-derived default trial budgets and explicit cap precedence. Feedback
compaction must preserve declared article excerpts and numerical measurements
through both host projection and Python proposal context.
