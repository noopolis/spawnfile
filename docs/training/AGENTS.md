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
