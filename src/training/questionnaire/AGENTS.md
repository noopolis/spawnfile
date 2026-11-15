# Questionnaire core

Owns the declared questionnaire verifier (`spawnfile.training.questionnaire.v1`): bank parsing,
strict answer parsing, scoring, the judge prompt and reply schema, the ordered group run, the
optimizer-visible projection and the calibration comparison. Public seam: `index.ts`.

- `types.ts`: bank, answer and score shapes; the prompt version.
- `bank.ts`: strict YAML and schema validation, defaults, cross-references (`after`, `receives`).
- `answers.ts`: `parseAnswer`, `scoreAnswer`, `judgeAnswer`, repeat `combineAnswers`, `scoreQuestionnaire`.
- `prompt.ts`: material rendering from declared `reads`, the fixed answering rules, one typed
  reply property per step.
- `run.ts`: one judge call per group per repeat on the group's named route, in declared order.
- `report.ts`: `questionnaireFeedback` (open questions only) and per-candidate summaries.
- `calibration.ts`: compares results with a bank's calibration set; never asks a judge.

Rules:

- Runtime-neutral: import contracts only. No evaluation, experiments, inference, CLI or engine names.
- An answer the declared type does not allow, or a missing one, is an `error`: it scores 0 and can
  never pass a gate. Never coerce, default or retry an answer into a pass.
- The judge sees questions, criteria and option ids. Scores, weights, gates and hidden flags never
  enter a prompt.
- Hidden questions and working steps never enter `questionnaireFeedback`; optimizer code reads only
  that projection.
- A group's `effort` is a requirement on its route, refused when the route declares another one.
- Changing the fixed answering rules or reply shape requires a new `QUESTIONNAIRE_PROMPT_VERSION`.
- Tests live beside source; keep every file above the 90% coverage floor and under 400 lines.
