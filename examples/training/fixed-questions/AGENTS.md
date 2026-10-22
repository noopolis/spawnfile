# Fixed-question example

Owns a generic, evaluator-only fixed-question grader and its dataset example.
Public seam: README.md and evals/. No private data, provider calls or subject
runtime implementation belongs here. Keep grounding and expected answers outside
subject workspaces. Verify through the case/CLI grader tests, strict dataset
resolution and TypeScript/lint checks; live model quality is not established.
