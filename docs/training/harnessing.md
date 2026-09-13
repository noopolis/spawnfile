# Native harnessing

**Implemented core, explicit adapter limits.** Native Codex and Daimon adapters,
Claude subscription inference, candidate installation and real DSPy optimization
have passed the [native formatting acceptance](../examples/native-formatting/README.md).
See [adapter support](../src/adapters/README.md) for exact capabilities. The broader
project-native integrations below remain design contracts where marked.

See the [Example Newsroom source mapping](../examples/newsroom-reporting/README.md#prompt-candidates) for a concrete
proposal with native declarations, editable prompt resources and isolated state.

```text
Project files + case ─→ Native adapter ─→ Real agent ─→ Capture + evaluate
```

## What is portable

The project supplies its own source resources, cases, criteria and registered fixture
tools. Paideia has no built-in newsroom vocabulary or special project paths. Each
adapter receives one resolved trial: immutable candidate manifest, visible task input,
workspace files, selected runtime/model profile, reset state, fixture tool bindings,
budgets and required observations. Evaluator-only material is not part of that input.

The common contract covers capabilities, prepare, submit, observe, collect, cancel
and cleanup. It must not become a lowest-common-denominator text wrapper. File, skill,
memory, attachment, tool and trace capabilities are independently declared. Native
options live in a validated adapter-specific profile, not opaque vendor flags in cases.
Adding another project requires declarations; adding another runtime requires an
adapter, without edits to the core case language.

The same source resources can be mapped into different native layouts. Transparent
means the mapping is inspectable and preserves declared intent, not that different
runtimes have identical system prompts, tools, memory semantics or output quality.
Reject unsupported required mappings. Never silently flatten on-demand skills into a
system prompt, disable memory, drop attachments or treat missing traces as success.

## Input channels

| Project declaration | Native destination |
| --- | --- |
| Identity and standing instructions | Native instruction/resource mechanism with recorded composition and precedence |
| Skill directory | Native discovery location or public skill registration, preserving metadata and relative references |
| Supporting files | Declared paths in the isolated workspace |
| Case prompt and structured data | The task message submitted through the native runtime input API |
| Attachments, when supported | Native attachment channel; unsupported types are explicit |
| Memory fixture | Reset through the declared memory backend; not pasted as fake conversation history |
| Fixture tools | Real callable test integrations; trusted effects journal outside agent-writable state |
| Expected answers and checks | Evaluator only; never implicitly included in the agent workspace or messages |

Native project instructions and runtime-added boilerplate must be included in the
effective-input manifest where observable. Capture their origin and precedence to
avoid loading an instruction twice. Ambient developer home customizations are not
silently inherited. Authentication uses the saved provider login mechanism without
copying credentials into candidate files, fixture contexts or reports.

## Actual runtime seams

| Runtime | Proposed public integration | What must be proved |
| --- | --- | --- |
| Daimon native Pi | Public per-agent harness, prepared workspace/home, `startAgent`, then `wake` and `stop` | Instructions reach effective input; declared skills are registered/loaded; fixture tools execute; terminal capture is complete |
| Standalone Pi | Public SDK resource loader/session or documented RPC input | Native skills and tool events remain native; accepted prompt is followed to terminal completion |
| Claude Code | Programmatic CLI/SDK, explicit instruction/resource configuration and fresh project session | Candidate resources load, task reaches the session, final result and observable tool events are captured |
| Codex | Pinned `exec` interface, task stdin, controlled project instructions/skills and workspace | Selected files load through native discovery; terminal result and trace coverage are established |
| OpenClaw | Pinned isolated agent execution interface and controlled workspace/state/config | No ambient production session/channel routing, capability-compatible source mapping, actual terminal work |

Codex and the Daimon CLI-engine integration are implemented. Standalone Pi,
Claude-as-subject and OpenClaw remain integration candidates; Claude currently
supplies tool-free optimizer and judge inference only. Pi's RPC documentation
explicitly distinguishes prompt acceptance from completion. Claude exposes programmatic
task execution and instruction configuration. OpenClaw currently documents an isolated
`agent exec` path; do not confuse it with delivery to a live messaging channel.
[Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md),
[Claude programmatic use](https://code.claude.com/docs/en/headless),
[OpenClaw agent execution](https://docs.openclaw.ai/cli/agent).

Local Codex `exec --help` was inspected on 2026-09-13: it accepts task input from
stdin and an explicit working root. The implemented adapters pin the observed protocol contract in their conformance
tests. New CLI versions need the same checks before their capabilities are advertised.

## The current Daimon gap

Local source inspection confirms Daimon's public `AgentStartInput` accepts `id`,
`name`, `instructions`, `workspacePath`, `runtimeHomePath` and optional tool names.
The handle accepts a `WakeEvent` with task `text` and exposes wake/status/stop.
The published Pi adapter additionally exposes memory, custom-tool and opt-in native
capture settings. The CLI-engine route has now completed isolated native Paideia trials through
these public seams. Required isolated-instruction and per-instance causal-context
changes are in the local Daimon feature worktree; an older runtime fails preflight.

However, the current Pi resource loader returns empty skills, prompt templates and
agent-file collections. Placing a `SKILL.md` in a workspace does not make that a
registered native skill. A generic public resource-loading extension belongs in
Daimon; Paideia should consume it and test it. Do not hide the gap by concatenating
all skill bodies into `instructions` or importing private Daimon implementation files.
The production CLI-engine route has different observability and must be tested
separately rather than inheriting claims from native Pi.

Spawnfile continues to own its source-format compilation. For an existing Spawnfile
agent, an optional preparation integration uses its public compile surface and receipt,
tracking how candidate source edits reach runtime files. Paideia must not grow a second
Spawnfile compiler. Other native adapters must work with no Spawnfile installed.

## Colocated evaluation and packaging

**Agreed layout; generic Paideia implementation available.** Keep `evals/` next to the canonical native
agent/project definition. Paideia remains the shared evaluation and optimization tool;
the datasets and editable-source selections belong with the agent they train. A trial
uses an isolated candidate copy and records its explicit overrides, preserving the
source project as baseline. Dataset location never changes the native working directory.

The agreed dataset naming is `<name>.paideia.yaml`, with `train.paideia.yaml` and
`test.paideia.yaml` as the example pair. The local `spawnfile train` implementation
delegates through Paideia's public interface: Spawnfile supplies its canonical agent
and environment; Paideia owns evaluation, optimization and isolated trials. Paideia
also has a standalone CLI for explicit Markdown resources and supported native runtimes.
The selected native runtime executes agent turns. No extra agent declaration or
mandatory experiment file is required. Commands and
flags exist for explicit Markdown resources and native Codex/Daimon trials.
Canonical extraction and the strict `spawnfile.training-context.v1` handoff are
implemented and tested across the actual CLIs. A native run still requires a
registered isolated project preparation; unsupported projects fail before cognition.
Dataset roles resolve explicitly in the invocation, never merely from filenames.

An installed project entry point imports `launch` from `@noopolis/paideia/cli` and
passes a `SpawnfileCliIntegration`. Its static preparation definitions validate case
parameters, its edit policies may narrow explicitly selected instruction/skill files,
and its adapter/preparation callbacks consume the canonical receipt. Identity stays
locked. Spawnfile selects that entry point with `--paideia-command EXECUTABLE`.
This registration supplies environment construction, not a second training loop:
the shared CLI owns signals, budgets, DSPy, datasets, judges, costs and stored results.
Dry-run uses static definitions only and calls neither execution callback.

Static validation and a generic runtime preflight do not prove an exact project
trial works. Native acceptance must exercise the selected compiled image, mounts,
authentication, shell and real task tools together, then verify the expected artifact
and terminal outcome. Missing capabilities may surface after cognition starts; those
attempts remain failures with retained usage, not successful preflight evidence.

Spawnfile projects add `.spawnignore`, using the proposed patterns `**/evals/` and
`**/.paideia/` for evaluator definitions and generated experiment artifacts. These files
remain readable to trusted Paideia preparation; only permitted task inputs and candidate
resources reach the subject. Dataset YAML stays tracked in Git. Generated experiment
state is also excluded from Git; `.spawnignore` and `.gitignore` have separate purposes.

Spawnfile owns generic packaging exclusion and its public receipt. Future enforcement
must cover source packaging and repository snapshots/bundles exposed as resources,
including nested agent folders. A Docker build-context filter alone cannot exclude
files already inside an archive or cloned at startup. Retained Git history or another
resource path must not expose excluded evaluator material; a filtered resource needs
an explicit snapshot contract, not a silently altered mutable Git checkout. An explicit
required native input conflicting with an exclusion must fail rather than disappear.

Current Spawnfile has no `.spawnignore` support. Its Git resources clone repositories
and bundle resources extract supplied archives. Paideia must not claim this convention
enforces isolation today or implement a second Spawnfile packager. Paideia still owns
case-specific source views, reference separation and held-out-data checks, which remain
necessary even after generic packaging exclusion exists. Other native adapters retain
their own packaging contracts and do not require a Spawnfile ignore file.

## Evidence required before training claims

For every candidate, record source and rendered bytes/digests, native destinations,
effective settings and inputs where observable, discovered resources, observed skill
loads, tool dispatch/completion, output artifacts and measured usage. Distinguish:

1. Installed: the resource exists at the declared destination.
2. Discovered: the native runtime exposed it as an available resource.
3. Loaded: observed evidence shows its content reached the session.
4. Followed: behavior/output satisfies the declared criteria.

Unavailable observations stay unknown; tool behavior does not prove unobservable
prompt bytes. The completed integration proof changes a declared Markdown instruction and uses
task-sensitive cases to show the change matters on native Codex and Daimon. A locked
identity resource remains unchanged. Native skill loading is still unsupported and
needs its own propagation and negative conformance tests before being advertised.

DSPy modifies declared
text components, Paideia creates fresh trials, evaluators produce evidence-backed
feedback, validation selects, and a sealed test measures generalization. Prompt
optimization does not update model weights or automatically deploy source changes.
