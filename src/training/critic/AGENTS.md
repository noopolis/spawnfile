# Prompt critic

Owns the prompt critic gate: one strong-model review of a candidate prompt against its baseline and
the declared house documents, and the selection rule that removes a blocked candidate. Public seam: `index.ts`.

- `overlap.ts`: changed lines between baseline and candidate; deterministic term overlap between
  added lines and train case texts (hints, never a verdict).
- `review.ts`: the fixed review instructions, prompt rendering, strict reply parsing and the verdict.
- `gate.ts`: `selectThroughCritic`, the walk from the best validation score down to the first
  candidate whose review passes.

Rules:

- Runtime-neutral: import contracts only. The judge is an injected route, the same named routes checks use.
- The verdict is computed here from findings and `blockOn`; a model-supplied verdict is never read.
- A critic that fails or returns anything but a review is an `error`, which removes the candidate
  exactly like `block`. Nothing here turns a failed review into a pass.
- A finding whose quote is not in the prompt it cites is kept, marked `unverifiedQuote`, and cannot block.
- The critic sees train case texts and declared checks only when the run shows them; it never
  receives validation cases, test cases or hidden questionnaire questions.
- The baseline is never reviewed and always stays selectable.
- Changing the instructions or reply shape requires a new `CRITIC_PROMPT_VERSION`.
- Tests live beside source; keep every file above the 90% coverage floor and under 400 lines.
