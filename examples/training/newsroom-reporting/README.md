# Newsroom reporting: an illustrative training example

One [Spawnfile](Spawnfile) with its environment, plus two datasets:
[train.paideia.yaml](evals/train.paideia.yaml) and [test.paideia.yaml](evals/test.paideia.yaml)
under `evals/`. Every record is inline and both files use the same
[Paideia dataset definition](../../docs/authoring.md). See the
[architectural view](../../docs/architecture.html) for how a full trial and training
process fit together.

**Everything here is synthetic.** The agent, its colleagues, the network, the story
identifiers, the Git repositories, the pinned revisions and every SHA-256 selector are
invented for this example. It exists to exercise the authoring surface for a realistic
multi-step reporting task, not to describe a deployment. Paideia dataset resolution
passes here (`src/cases/examples.test.ts` reads both files unchanged); the Spawnfile is
a declaration in the native format and has not been re-validated by the Spawnfile
compiler since these names became synthetic. The generic evaluators and the real DSPy optimizer
are implemented and tested on the separate
[native formatting example](../native-formatting/README.md); this environment, its named
`newsroom/*` evaluators and its source preparation are declared, not implemented.

```text
newsroom-reporting/
├── Spawnfile
├── .spawnignore
├── environment/scribe/
│   ├── AGENTS.md
│   ├── SOUL.md
│   └── RUNBOOK.md
├── evals/
│   ├── train.paideia.yaml
│   └── test.paideia.yaml
└── README.md
```

Contributor guides and compatibility symlinks are omitted above. There is no per-record
YAML, second native agent configuration, runtime profile or experiment file to author.
The training invocation selects the Spawnfile, subject, train/test datasets, editable
prompt sections, optimizer/judge subscription routes and budgets. Canonical Spawnfile
extraction and the local `spawnfile train` delegation are implemented.

Spawnfile supplies the canonical project through Paideia's public interface. Native
execution also requires an explicitly registered isolated preparation; the profiles and
evaluators proposed here are not installed by that handoff. Paideia's standalone CLI
also trains explicit Markdown resources through Codex or Daimon.

## Keep evaluation beside the native agent

The agreed layout puts `evals/` beside the agent's native definition. In a real project,
Paideia reads that canonical definition and prepares a candidate copy with explicit
isolation overrides. Moving these datasets does not change their resource-relative
selectors or the subject's native working directory. Select the parent Spawnfile as the
native project.

[.spawnignore](.spawnignore) declares that `evals/` and generated `.paideia/` artifacts
must stay out of packaged agent workspaces. These are packaging exclusions; datasets stay
versioned in Git. **Spawnfile does not implement this file yet.** The policy is an agreed
authoring convention, not an enforced protection or permission to launch. See the
[native packaging contract](../../docs/harnessing.md#colocated-evaluation-and-packaging)
for ownership and the resource-copy paths future enforcement must cover.

## Records

| Dataset | Record | Invented subject |
| --- | --- | --- |
| Train | `kestrel-reporting` | A harbour drill and the hardware mix it establishes |
| Train | `voltrail-reporting` | A battery-train order, its delivery clock and implications |
| Test | `marovia-flare-gas-reporting` | A flare-gas permit review and possible revocation |

Every file selector carries a resource id, a path inside that resource and an exact byte
hash, so a project can substitute its own corpus without changing the authoring shape.
The reference article in each record is an evaluator-only comparison input, never an
answer supplied to the subject or a factual gold standard.

Three records across two splits is a shape demonstration, not evidence of anything.
The implemented runner withholds test inputs and feedback during optimization, but naming
a file `test.paideia.yaml` does not by itself establish that its subject matter is unseen.
A real generalization claim needs independently selected record families, grouped so that
related stories cannot straddle the split.

## Reuse preparation and evidence packets

Each dataset declares named `fixtures` in the same YAML. Every record keeps its identity,
evidence group and exact task prompt, and explicitly selects two fixtures:

| Fixture | Contents | Used by |
| --- | --- | --- |
| `afternoon-assignment` | 13:30 Berlin clock and native mention delivery | Both training records; declared separately in test |
| `kestrel-evidence` | Edition/story context, three input selectors and one reference article | Kestrel training record |
| `voltrail-evidence` | Edition/story context, three input selectors and one reference article | Voltrail training record |
| `marovia-flare-gas-evidence` | Edition/story context, three input selectors and one reference article | Test record |

For example, the Kestrel record selects `use: [afternoon-assignment, kestrel-evidence]`.
Dataset `setup` still supplies the shared recipe, isolation, source views and collector;
dataset stages still apply to every record.

The [fixture contract](../../docs/fixtures.md) defines map merging, atomic arrays, conflict
rejection before local overrides and locked-policy checks. The generic resolver implements
these authoring semantics. References remain evaluator-only, split checks use the expanded
selectors, and reuse never creates shared mutable trial state.

## Pinpoint the information to load

Each `input.files` item names a Spawnfile resource, a path inside it and a SHA-256. For
example, `private-archive` plus `2026-09-12/stories/s-1a2b3c4d.md` resolves under the
declared `repos/newsroom-archive/` mount, and the file keeps that native path. A
`reference.files` selector uses the same addressing but stays evaluator-only.

The Spawnfile pins both sources to fixed revisions. A resolver must check revision and
file hash before a paid run and must never silently read a newer checkout.

Only the active record's prompt and selected evidence reach the subject. Checks, rubrics,
reference articles and other records stay outside its mounts — including reference outputs
from sibling training records, even older ones. The `before-edition` public view keeps code,
reference and catalogue paths plus older eligible context while excluding the target edition,
later outputs and future state. Across every training and validation view, additionally
exclude all test inputs and reference articles even when they predate that edition.
Aggregate index rows must be filtered by edition and excluded story identity as well:
hiding article files alone would still leak their summaries through the index. Exclude each
held-out or reference story across all derivatives — edition indexes, composed pages, feeds,
search entries, exports and caches. Preparation enumerates these artifact classes; unnamed
derivatives cannot silently remain visible. The `input-files` private view keeps only the
selected evidence paths.

Those view names are **proposed preparation profiles**, not features implemented by
Spawnfile or Paideia today. A bare Spawnfile launch would expose full Git resources and
would not be a valid trial. Preparation must create filtered views and prove that no
alternate path, Git history, cache, tool mount or memory leaks excluded data.

## The environment

`environment/scribe/` holds the example's own prompt seeds: a locked identity, a standing
instruction file and an on-demand runbook. They are written for this example. A project
applying this shape points the same Spawnfile fields at its own files instead of copying
them here.

| Declared behavior | Explicit isolation |
| --- | --- |
| Standing prompts and on-demand runbook | Candidate copies, never edits to the source |
| Public/private source identities and native paths | Frozen filtered resource views |
| Article validation, filing and attributed Git history | Fresh edition state built through real acceptance rules |
| Room names and authenticated sender identities | Separate loopback server; peers are fixture services |
| Memory backend and tool interfaces | Empty initial memory, explicitly labeled reconstructed |
| Wake ids and authorization contracts | Isolated host/control credentials; no admission bypass |

The Spawnfile declares both repositories and the MCP commands. Read-only tool volumes stand
for prepared closures at `tools/newsroom` and `tools/article-validation`; they are mount
declarations, not shipped tool servers, and a real run must populate and verify them against
pinned source and dependency manifests. The harness must emulate external peers through real
transport and preserve tool failure semantics. It must not invoke the subject's reporting
tools on its behalf.

`setup.profile: newsroom/assigned-story` proposes a trusted preparation recipe that creates
an authorized assignment and fresh history before the subject wakes. Assignment setup is
reconstructed, not a replayed conversation. `fidelity: reconstructed` and `memory: empty`
make that explicit; a request for exact replay must fail rather than pretend.

`setup.isolation` requires a fresh container and trial-owned mounts, memory and control
credentials. The native `/var/lib/spawnfile/instances/daimon/daimon-organization` root is a
compiler constant, independent of the team name; preserve that internal path and never bind
it to a production host directory. The fixed memory SQLite path receives a fresh empty
volume. The loopback control service belongs to this container and provisions a fresh token.
Missing ownership proof or unavailable isolation blocks preflight.

`setup.clock` starts an emulated clock on the record's edition date at 13:30 Berlin. All
agent, tool and runtime wall clocks must agree; real elapsed-time budgets stay separate.
`setup.delivery` sends the task as one authenticated mention in `room:assignment` after state
preparation. Setup itself sends no task or wake; the native mention is the sole wake trigger.
Its exact text is `@scribe` + LF + the YAML-parsed prompt bytes, without trimming. Record the
stored bytes, the sender identity, the host wake id and the terminal outcome.

Schedules are disabled, state must be trial-owned, credentials stay outside YAML and
production federation is absent. Model authentication uses the selected subscription. No live
research is sent by these datasets; they test reporting from supplied packets. A research-loop
dataset would need recorded request/answer evidence or explicitly declared emulation.

## Prompt candidates

A training call over this example allowlists **Prose and beat** in `AGENTS.md` and
**Article craft**, **The article wake** and **Asking for research you do not have** in
`RUNBOOK.md`. `SOUL.md`, the remaining sections, tools, model, memory policy, evidence,
criteria and source pins stay locked unless a separate experiment explicitly changes them.

The training invocation records this source-to-destination mapping in its generated manifest.
Paths below are relative to the subject's native workspace; sources are under
`environment/scribe/`. These are required bindings, not prose-only hints.

| Local source | Native destinations / mechanism |
| --- | --- |
| AGENTS.md | Spawnfile `workspace.docs.system` produces the native instruction/config surface and workspace AGENTS.md; overlay `repos/newsroom/example-org/agents/scribe/AGENTS.md` too |
| SOUL.md (locked) | Spawnfile `workspace.docs.soul` produces the native identity/config surface and SOUL.md; preserve an identical mirrored copy |
| RUNBOOK.md | Overlay `repos/newsroom/example-org/agents/scribe/RUNBOOK.md`; remains on-demand, not injected into the standing system prompt |

Overlay only the candidate's isolated filtered public view before native preparation. The
pinned Git tree remains baseline provenance; record base, candidate and effective destination
hashes separately. Never mutate the source repository or install an untracked post-compile
edit. The preparer must bind the candidate view through the native public resource contract;
if that is unsupported, fail preflight. Verify every destination and native instruction
receipt; deleting a mapping must fail before optimization can start.

DSPy proposes edits in a candidate copy. Spawnfile prepares that candidate through its public
compiler; each record and repetition starts a fresh native subject. Propagate changes to both
compiled instructions and mirrored public references. Verify effective input and observed
loading where available: installed, loaded and followed differ.

Train feedback may improve prompts. Candidate selection must use training-only data or a
group-based validation partition of it. The test dataset is used only after the candidate is
frozen. Save source/capture identities, scores, coverage, latency and separate
subject/optimizer/judge usage. Missing evidence is unknown, not a pass or a zero cost. No
candidate is automatically applied to any deployed organization.

## Evaluation and remaining work

Both datasets declare a shared `live` check for the reporter's standing ban on direct
research. See the [initial live policy](../../docs/live-evaluation.md) for its authoring
semantics and required trusted environment audit. The generic live runner is implemented; the
named newsroom evaluator is not, and a tool-name blacklist cannot substitute for a trusted
environment audit.

The multi-step task lets the subject read, draft, fail validation, repair, revalidate, file
and notify the reviewer. Only a proven decisive violation selected for stopping can end it
early. Semantic checkpoint observations stay advisory; final quality gates apply.

Dataset-level stages apply to every inline record. Mechanical gates check the article format,
validation-before-filing, attributed acceptance and the separate reviewer handoff. The ordered
check accepts repair loops but must end at the collector's actual accepting call; an earlier
successful pair cannot excuse a later unvalidated filing. Semantic judges then assess grounding
and prose with inline fixed rubric prompts. The weighted score cannot compensate for failed
mechanics or an individual hard gate. The thresholds are examples to calibrate; a parser
accepting YAML does not validate prose.

`setup.artifacts.accepted-article` binds a read-only collector to the admitted filing for this
trial's owner, edition and article id. It must verify native acceptance receipts and Git file
bytes, retain digest lineage, and reject absent or conflicting matches. A validation payload or
an agent-written receipt is not acceptance.

Both datasets intentionally carry the same shared plan. The resolver rejects different
normalized plan digests, including the live policy, judge versions, rubrics, gates and weights.
Compared runs also freeze budgets, checkpoint and retry policies. The combined threshold lives
only in the gate. No extra rules YAML is required.

The named `newsroom/*` evaluators and preparation profiles still need typed adapters. They must
inspect authentic receipts and artifacts rather than believing a final-text claim or calling a
filing mutator again while grading. Validation, admitted filing, file-byte and Git commit
identities differ; join them using their actual serialization contracts. Source support still
requires semantic assessment after mechanical citation checks.

A CLI session surface that reports a synthetic terminal event with empty tool results cannot
satisfy these ordered tool checks. A trusted MCP journal or native engine event export, joined
to actual host wake and acceptance identities, is a prerequisite. Missing call evidence remains
unknown, even if the final text looks right.

Nothing here has been compiled, deployed or run. A matching runtime artifact, prepared tool
closures, isolation, emulated-clock handling, authenticated state setup and trace coverage would
all have to be demonstrated before any environment-parity or training claim, and the Spawnfile
itself needs a fresh compiler validation run.
