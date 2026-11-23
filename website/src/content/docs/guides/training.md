---
title: Training
description: Improve an agent's prompt docs against your own train and test cases, in trials that boot your real organization the way production does.
---

`spawnfile train` improves one agent's Markdown docs, such as `AGENTS.md` or `SOUL.md`, against cases you write. Each trial runs the selected agent with its compiled configuration in an isolated container. Judges score each result, an optimizer proposes better versions of the files you marked editable, and the best candidate is scored on a test set it never saw.

Training produces a candidate and its evidence. It never deploys the candidate; you review it and commit it like any other change.

## Requirements

- Choose **Daimon**, **Hermes Agent**, **OpenClaw**, **OpenCode** or **PicoClaw**. For a Daimon agent, select Codex or Grok.
- **Docker** is available.
- Supply credentials for the selected model. For a subscription route, select the harness login with `--auth-profile`. Daimon uses a shared auth gateway. The other harnesses run their native commands.

A dry run needs none of that: it validates and estimates without Docker, logins or model calls.

## Declare training

Training lives in the Spawnfile. A team can set shared defaults with `shared.training`; each agent declares its own `training` targets.

```yaml
# Team Spawnfile
shared:
  training:
    optimizer: { method: gepa, model: claude-opus-5-5, variants: 8, keep: 3, budget: { rounds: 10 } }
    graders: { writing: training/writing.grader.yaml }
```

```yaml
# agents/writer/Spawnfile
training:
  optimizer: { budget: { rounds: 30 } }
  targets:
    - files: [AGENTS.md]
      grader: writing
      datasets:
        train: training/train.yaml
        validation: training/validation.yaml
        test: training/test.yaml
```

- **Targets** name the `.md` files the optimizer may rewrite, the grader that scores them, and the datasets. `train` and `test` are required; `validation` is optional.
- **Optimizer** fields merge from the team into each direct member; closer fields win. An agent with targets needs all of `method`, `model`, `variants`, `keep` and `budget.rounds` in the end.
- **Graders** map a name to a grader file. Targets are never inherited; each agent declares its own.
- Shared training applies only to direct members. It does not cross into nested teams or subagents.

All paths are relative to the Spawnfile that declares them.

## Write cases

A dataset is a list of **moments**: an optional starting state plus one wake. A plain prompt case is a moment with no starting state.

```yaml
examples:
  - id: outage-summary
    wake: { surface: moltnet, room: general, from: lead, text: "@writer summarize the outage notes" }
    resources:
      - id: shared-notes
        kind: volume
        mount: ./shared
        mode: mutable
        files: { "outage.md": "# Outage\n..." }
    output: shared/summary.md
```

- **`wake`** is the message that starts the turn.
- **`resources`** fill the agent's declared workspace volumes before the wake, from inline `files`, a pinned Git ref or a directory.
- **`output`** is the file the trial leaves as its result. Without it, the final reply is graded.
- **`grader`** and **`context`** can override the target's grader for one case.

Moments can also come from real work. With `record` enabled in the training declaration, deployed agents keep a history of their turns, and `spawnfile train --materialize <example> --history <dir> --out <dir>` rewinds one into a reproducible starting state.

## Run it

Check what Spawnfile resolved, then estimate the cost:

```bash
spawnfile train ./Spawnfile --agent writer --plan
spawnfile train ./Spawnfile --agent writer --dry-run
```

`--plan` prints the resolved training plan. `--dry-run` validates the datasets and estimates the spend; it makes no model calls.

Then train:

```bash
spawnfile train ./Spawnfile --agent writer --auth-profile default --out .training/writer
```

`--agent` takes an exact agent id or an unambiguous short name, and can be omitted when the project has one agent. If a run stops, continue it from the same output directory:

```bash
spawnfile train ./Spawnfile --agent writer --auth-profile default --out .training/writer --resume
```

Resume checks that the inputs and budgets are unchanged before restoring the optimizer.

## Useful options

| Option | What it does |
|---|---|
| `--train`, `--validation`, `--test` | Use explicit dataset files instead of the declared ones. |
| `--editable <file>` | Mark a file editable. Repeatable. |
| `--cost-config <file>` | Price the estimate with your own cost table. |
| `--max-trials`, `--max-proposals` | Cap the run. |
| `--experiment-timeout-ms`, `--trial-timeout-ms` | Override the deadlines. The experiment default is 12 hours. |
| `--concurrency` | Run trials in parallel. |
| `--seed` | Make sampling repeatable. |

## How a trial runs

1. Spawnfile compiles the candidate into the agent's native files, exactly as a deploy would.
2. The trial opens the compiled runtime in an isolated container.
3. The case's starting state is installed, and the wake is delivered.
4. When the turn ends, judges score the output. The container is removed.

Validation scores guide the optimizer. Test cases run only after the best candidate is frozen, so the final score is on unseen cases.

## Regrade a saved trial

Each stored trial writes a private `.eval` file in the output's `evals/` directory. It includes the task, reply, observed actions, selected files, grades and evidence coverage. Run `spawnfile train --regrade sample.eval --out graded` on a saved file to score its final checks again. The new result is `graded/REGRADE.json`. Missing events stay unknown when tool coverage is partial.

## Learn more

- [Training specification](https://github.com/noopolis/spawnfile/blob/main/specs/TRAINING.md) for every field, the moment format and the receipts.
- [Training examples](https://github.com/noopolis/spawnfile/tree/main/examples/training) for complete datasets.
