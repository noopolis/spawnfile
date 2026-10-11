# Canonical agent training

`spawnfile train` resolves one agent from its full project and delegates to an installed
Paideia CLI. Spawnfile owns canonical source resolution, training authoring and native
compilation; Paideia owns evaluation, cost planning, optimization and isolated trials.

The [container boundary](TRAINING_CONTAINERS.md) runs the complete experiment
inside one immutable image. The v2 training configuration prepares its pinned
image and inputs behind the same command; the v1 image/mount path remains
available. Dry-run remains a host-only estimate.

`spawnfile.training-container.v3` adds a brokered Grok slot to that boundary:
the subject's model runs in the same container under a root-provisioned broker,
the evaluator recycles that slot between trials through a single-verb root
supervisor, and judges spend the one dedicated training Grok login through
bounded inference grants instead of holding it. Import that login with
`spawnfile auth import grok --profile paideia-training --from <directory>`; the
desktop `~/.grok` is refused, because a training run rotates the credential it
is given.

```sh
spawnfile train ./Spawnfile --agent agent:writer \
  --train evals/train.paideia.yaml --test evals/test.paideia.yaml \
  --editable agents/writer/AGENTS.md --cost-config local-costs.yaml --dry-run
```

Paideia supplies the cost-config format and training options. Dataset roles are explicit.

`--resume` forwards to Paideia for the same output directory. Paideia validates
unchanged canonical inputs, the isolated integration's execution identity and
cumulative budgets before restoring its optimizer and native evidence. Spawnfile
does not interpret checkpoints, repeat trials or deploy the optimized candidate.
`--agent` is an exact resolved node ID; omission is allowed only for one-agent projects.
`--paideia-command` selects an installed executable, default `paideia`; no shell,
automatic installation, model-provider fallback or production launch is involved.

## Authoring

Teams (including the root organization) MAY declare `shared.training`; agents and
inline agent members MAY declare `training`. No other training fields are accepted.
All training file paths MUST be relative, use forward slashes, and resolve from
the declaring manifest's directory.

```yaml
# Team Spawnfile
shared:
  training:
    record: { keep: 30d, volumes: [edition-state] }
    optimizer: { method: gepa, model: claude-opus-5-5, variants: 8, keep: 3, budget: { rounds: 10 } }
    graders: { writing: training/writing.grader.yaml }
    targets:
      - files: [SOUL.md]
        grader: writing
        datasets: { train: training/train.yaml, test: training/test.yaml }

# Direct agent member's Spawnfile
training:
  optimizer: { budget: { rounds: 30 } }
  targets:
    - files: [AGENTS.md]
      grader: writing
      datasets: { train: training/train.yaml, validation: training/validation.yaml, test: training/test.yaml }
```

- `record` MAY contain `keep` and `volumes`. `keep` MUST match `^[1-9][0-9]*[mhd]$`;
  volumes MUST be unique nonempty resource IDs. Recording is off without an effective
  `record`; `record: {}` enables recording with a default retention of **30d**.
- Every optimizer field is OPTIONAL at declaration time. `method` and `model` MUST
  be nonempty strings; `variants`, `keep`, and `budget.rounds` MUST be positive integers.
  An agent plan with any target MUST have all five effective fields and `keep <= variants`;
  a validation error MUST name missing fields. An incomplete optimizer without targets
  is represented by `null` in the plan.
- Grader names MUST match `^[A-Za-z0-9_-]+$` and MUST NOT be `__proto__`.
  Each name maps to one relative file path.
- Each target MUST contain nonempty, unique `.md` file paths, a grader name, and
  `datasets` with required `train` and `test` paths and OPTIONAL `validation`.

`shared.training` applies ONLY to direct agent members, referenced or inline. It
MUST NOT cross a nested-team boundary or propagate to subagents. Effective training
merges that direct team's declaration (excluding targets) with the agent's declaration:
`record` and `optimizer` merge by field, including `optimizer.budget`; closer fields
win, and arrays replace wholesale. Graders merge by name with agent-local shadowing;
each path retains its declaring directory and node. Targets are never inherited.
The team retains its own declared targets and graders. Reaching one canonical agent
through incompatible effective training declarations MUST fail validation; equivalent
declarations are accepted. Grader source and declaring-node provenance participate in
that comparison.

Every target MUST be an existing regular `.md` file inside its declaring manifest's
directory, checked by realpath without symlink escape. A nested directory containing
another `Spawnfile` owns its entire tree, even if that node is not in the compiled graph;
an ancestor MUST NOT target its files. A target MUST equal a resolved document or skill
entry `sourcePath` of at least one compiled agent. Errors MUST name the file and declaring
node. Team targets list every consumer's exact node ID, sorted. Each agent's plan includes
its own targets and team targets for which it consumes at least one file; each included
target retains its complete file list and consumer lists. Agent targets use effective
graders; team targets use only their own team's graders, unaffected by agent shadowing.
Target, dataset, and grader filesystem checks occur ONLY during training-plan loading;
ordinary compilation validates training structure without requiring those files to exist.

Dataset and grader paths MUST name existing regular files whose lexical paths and realpaths
are inside the project root (the compiled root manifest's directory).
Dataset YAML MUST reject duplicate keys and unknown fields at every level.
Dataset files use one strict YAML shape for all three roles:

```yaml
examples:
  - id: ice-shooting
    at: 2026-10-09T10:20:31+02:00
    wake: { surface: moltnet, room: assignment, from: brass, text: "@writer report the event" }
    memory: [{ id: self, store: { kind: memory } }]
    resources: [{ id: edition-state, kind: volume, mount: ./edition-state, mode: mutable }]
    networks:
      - id: news
        provider: moltnet
        rooms: [{ id: assignment, members: [writer] }]
```

`examples` MUST be nonempty; IDs MUST be unique within the file and match
`^[A-Za-z0-9._-]+$`. `at` is a REQUIRED ISO-8601 instant with an offset or `Z`.
The strict v1 wake contains only `surface: moltnet` and string `room`, `from`, `text`.
Optional `resources`, `memory`, and `networks` are full declarations validated by the
existing workspace-resource, memory-bank, and team-network schemas, respectively.
Overrides MUST identify an existing effective item; they never add an item. Resource
IDs resolve against compiled `workspaceResources`; memory IDs resolve against the
compiler's accessible own and team banks; network IDs resolve against team networks
present in the agent's resolved surface attachments (including representative attachments).
Zero matches is unknown; more than one distinct item is ambiguous. The resolved plan
reports the matching item's declaring node ID. Team-target datasets MUST resolve for
EVERY consumer; one consumer's failure rejects the plan. Per-agent plans report the
selected consumer's resolved IDs. There is no dataset `files` field or environments file.

The grader file's format is specified by the grader phase; this phase only requires that the path names an existing regular file inside the project.

```sh
spawnfile train ./Spawnfile --agent agent:writer --plan
```

`--plan` prints `spawnfile.training-plan.v1` as JSON with two-space indentation and a
trailing newline, then exits 0. `--train` is not required with `--plan`; `--dry-run`
does not change plan behavior. Selection requires the exact compiled agent ID unless
the project has exactly one agent. Planning reads local sources and builds the resolved
graph; it MUST NOT create a training context, invoke Paideia, emit compiled artifacts,
build images, use Docker/auth, or execute training. Existing delegated training still
requires `--train`; the authoring surface does not change that execution path.

The plan's file entries carry absolute `sourcePath` and project-relative POSIX `path`.
`record.volumes` MUST uniquely resolve to effective unfed volume resources; git/bundle
resources and fed volumes MUST fail (feeds already have a landing log). The plan records
volume declaration IDs, grader file references, targets, and dataset example identities/overrides.
Graders include the selected agent's effective registry plus graders used by included
team targets, retaining provenance when names overlap. Keys and arrays are sorted; pure
resolution MUST be deterministic and perform no I/O or clock reads. The generated schema
appears between the `training-plan-schema` markers below.

## Moment record

The recording PR (`feat/training-recording`, not yet merged) owns the normative
`spawnfile.moment-record.v1` format in `specs/TRAINING.md`, “Moment record” and
“Host histories and retention”. Rewind depends on that PR, not the superseded
format sketch. The consumer-dependent recording text below is carried unchanged
until the recording PR merges; it is the same contract, not a second format.

All instants MUST use one host clock, shared by its containers, and include an offset
or `Z`. Every pin MUST describe state in effect at `wake.startedAt`, not capture time.
A later `recordedAt` MUST NOT advance a pin.

- `agent` MUST be the exact compiled node ID; `recordedAt` is the capture instant.
- `wake` MUST contain `at`, `startedAt`, `executionId`, and nonempty `deliveries` of
  `{deliveryId, kind, occurredAt}`. `at` is the first delivery's `occurred_at` (real wake
  time); `startedAt` is when the turn began. Queued deliveries can precede that instant.
  `surface`, `room`, `from`, and `messageId` are OPTIONAL, derived from a
  `moltnet:<id>` delivery and its Moltnet message when available; other deliveries
  MUST NOT invent Moltnet metadata.
- `resources` MUST use `{id, kind:"git", commit, sha256?}` or
  `{id, kind:"bundle", sha256}` from the deploy resource entry in effect at
  `startedAt`, selected by deployment record identity and `agent_node_ids` containing
  that exact agent node ID. Bundles have no commit. An inexact activation boundary
  MUST set the moment's `exact:false`; an overlapping predecessor can still run old pins.
- `feeds` MUST use `{id, revision, tree, commit?, ref?, paths?, landedAt, period?}`
  from the landing entry in effect at `startedAt` for each consumed fed volume.
  A wake inside the inclusive `[switching_at, landed_at]` transition window MUST
  set `exact:false`; the helper returns that landing with `ambiguous:true`.
- `memory` MUST use `{id, declaredBy, seq}` for each accessible bank. `seq` is the
  highest Mneme ledger sequence whose `createdAt <= startedAt`; 0 means empty.
  `generation` is OPTIONAL and MUST be omitted while Mneme has no generations.
  Mneme's append-only `events.jsonl` is the source of truth; there are no curation
  archives or generations to pin today.
- `moltnet` MUST use `{network, cursor}` with `cursor = startedAt`. Visible history
  contains messages with `created_at <= cursor`: server timestamps order history,
  while message IDs do not order messages across rooms. OPTIONAL `messageIds` lists
  wake message IDs, not a history cursor.
- `volumes` MUST use `{id, snapshot}` for each successful pre-turn snapshot of an
  effective `record.volumes` root. A failed root MUST be omitted and named in OPTIONAL
  `errors: [string]`. REQUIRED `exact` MUST be `false` on any snapshot or pin failure;
  otherwise it MUST be `true`. Missing or invalid history MUST NOT be guessed.

Recorded commit fields MUST additionally be full 40- or 64-hex object IDs,
normalized to lowercase and verified as commit objects without peeling tags.
Bundles carry only a `sha256:…` digest, never a commit. Unknown fields refuse.

## Rewind

```sh
spawnfile train ./Spawnfile --agent agent:writer --materialize train:ice-shooting --history ./history --out ./moment
```

`--materialize <example>` MUST require the existing `--out` option and follows
the plan's exact-agent selection (inferred only for a single-agent project).
It requires neither `--train` nor `--training-config`. It is mutually exclusive
with `--plan`. `--history` is OPTIONAL and applies only to materialization. The
command resolves the authoring plan and selected example using local files. It
MUST NOT invoke cognition, Paideia, Docker, authentication, network access, or
compiled-artifact emission. `materializeTrainingMoment({plan, project, example,
historyDir?, out})` exposes the same operation to trial preparation. Selection,
input enumeration, and historical cuts are available as pure library functions.

The example selector is an ID from the agent's plan targets. If that ID occurs
in several dataset/role pairs it MUST be qualified as `train:<id>`,
`validation:<id>`, or `test:<id>`. Repeated references to the same dataset, role,
and example are one candidate. A qualified selector that still matches several
datasets MUST refuse. Ambiguity errors MUST list role, ID, and dataset for every
candidate.

### Inputs and history

Inputs are EVERY effective item in the agent's compiled `workspaceResources`,
accessible `memoryAccess` banks deduplicated by bank source, and Moltnet networks
in its resolved surface attachments, including representative attachments. Each
input is identified by `{section, id, declaredBy}`, using the same declaring-node
resolution as authoring-plan overrides. Sections are `resources`, `memory`, and
`networks`. A dataset example's full declaration replaces the effective item
with the same section and ID; the plan guarantees exactly one match. Relative
paths in replacement declarations resolve from the dataset file's directory.
Every input MUST materialize successfully; present-day data MUST NOT substitute
for unavailable history.

The local history import layout is normative:

```text
DIR/
  moments/**/*.json                         # one record per file; .jsonl also accepted
  bundles/<sha256 hex>.tar
  git/<declaredBy>/<id>/                    # local repository mirror
  feeds/<declaredBy>/<id>/landings.jsonl
  feeds/<declaredBy>/<id>/repo/              # local git source mirror
  feeds/<declaredBy>/<id>/trees/<tree name>/ # preserve .N re-land suffixes
  memory/<declaredBy>/<id>/events.jsonl
  moltnet/<declaredBy>/<id>/state.json | moltnet.sqlite
  recording/<agent slug>/wake-moments.jsonl
  recording/<agent slug>/snapshots/<root id>/<snapshot id>/
  recording/<agent slug>/snapshots/<root id>/<snapshot id>.manifest.json
```

`<declaredBy>` MUST be `encodeURIComponent` of the node ID: `agent:writer`
becomes `agent%3Awriter`. `<agent slug>` is the selected compiled node's existing
slug, including the compiler's collision handling. `<root id>` is the
`record.volumes` resource ID. IDs and archive names MUST be safe path segments.
Every read MUST remain inside `DIR` lexically and after realpath resolution;
symlink escapes refuse. JSON and every JSONL line are validated strictly;
invalid lines refuse the affected input with file, line number, and reason.

Import copies deployment evidence verbatim: composed moment JSON files; the
host feed state's `landings.jsonl` beside `landed.json`; retained feed volume
`trees/` directories; deployed bundle tars from `container/workspace-bundles/`;
Daimon's persisted `recording/<agent slug>/` rows, snapshot trees and manifests;
Mneme's `<home>/memory/events.jsonl`; and the network's consistent Moltnet store
(including SQLite recovery sidecars when needed). The `git/` repositories and
feed `repo/` directories are local mirrors retaining historical commits, not
recorder output. Rewind neither fetches nor changes these mirrors.

Feed logs follow the recording PR's `spawnfile.volume-feed-landing.v1` shape:
`{version, resource, volume, revision, tree, source, commit?, ref?, paths?,
switching_at?, landed_at, period?}`. Source identifies `{kind:"git", repo}` or
`{kind:"directory", directory}`, with optional prepared provenance. This reader
accepts older entries without `switching_at`; new recording writes transition
boundaries. The isolated compatibility reader must be replaced by P3's
`readFeedLandings` / `feedLandingAt` after that PR merges.

Moment records match exact compiled `agent` and parsed `wake.at == example.at`.
For several attempts of that wake, select the EARLIEST `wake.startedAt` (original
turn), even when replay pins differ or append/capture order differs. Conflicting
copies at that same earliest instant still refuse when any input's effective
decision differs: usable pin versus fallback, selected pin, or fallback fidelity
given `exact` and input-specific `errors`. The refusal MUST name the input.
Unrelated errors and unusable pin values do not create a conflict.
Validate recorded commit IDs in every earliest-attempt copy for each used input,
including IDs hidden by declared pin precedence; later replays cannot replace
or invalidate the original turn's pins.

The report retains dataset `at` and adds `effectiveAt = selected wake.startedAt`,
or `effectiveAt = at` if unmatched. Task-clock origin, historical selection, and
leak bounds MUST use `effectiveAt`. Report the matching count, selected execution
ID, selected start instant, and `earliest-startedAt` choice. All comparisons parse
instants, preserving RFC3339 nanoseconds rather than ordering strings or UUIDs.

An `exact:false` record does not invalidate healthy pins: a present pin is used
with `exact` fidelity and `record` basis (`record-cursor` for Moltnet), unless its
`errors` names that input. Errored pins are ignored, absent pins use fallback
rules, and those inputs are labelled `approximate`, with the record's error text
in notes. Explicit section or declaring-node qualifications apply only to that
input; unqualified ID errors conservatively apply to every input with that ID.
A missing fallback still refuses. No matching record uses the normal
rules below; independent immutable git pins and unambiguous landing logs may
still be exact.

### Per-input reconstruction and fidelity

Each successful input reports `fidelity: exact | approximate | overridden`, a
`basis`, and the selected source identifiers. Explicit overrides report
`overridden` and `basis: override`. A replacement git/bundle declaration must
still supply locally available historical bytes. A replacement memory bank,
network, or volume starts fresh: an empty bank/volume, or an empty network store
with its declared rooms. A network override writes a fresh `state.json` snapshot
regardless of its declared storage backend; trial preparation consumes or imports
that snapshot. With no `--history`, only locally materializable pins
and explicit overrides can succeed; everything else refuses.

Git resources select a full 40- or 64-hex declared
commit first (`exact`, `pinned`), otherwise the matching record's resource
commit (`exact`, `record`). Otherwise they walk the declared selector's
first-parent history and choose its newest commit with committer time `<= effectiveAt`
(`approximate`, `selector-at`); an absent selector means `HEAD`. Commit dates
do not establish when a commit reached a branch or tag, so this fallback cannot
prove historical ref membership. A missing eligible commit refuses.
The selected commit's author AND committer dates MUST be `<= effectiveAt` before any
git checkout or bundle extraction, including pinned, recorded, and overridden
git sources. All paths MUST use the same selected-commit guard.

Git output MUST be a clean new repository containing only objects reachable
from the selected commit, with one checked-out branch, no remotes, tags, source
packed refs, reflogs, `FETCH_HEAD`, or `ORIG_HEAD`. Git commands use argv without
a shell and sanitized configuration. History MUST NOT be mutated. The leak
check also rejects any reachable ancestor with author or committer time after
`effectiveAt`. Bundle `build.files` extracts `files.root` at the selected commit and honors
`exclude`. `build.dependencies` and `build.generated` retain their source
directory or declared inputs at that commit and report `build: deferred`;
trial preparation owns builds. Bundle output MAY be a plain tree. A record pins only its bundle SHA-256.
Exact bundle output requires `bundles/<sha256 hex>.tar` whose actual digest
matches that pin. Validate the archive before extraction: escaping paths,
symlinks, hard links, devices, and other special entries refuse. Acceptance
reopens the archive and compares output paths, bytes, and executable modes.
Absent or digest-mismatched archives fall back to source reconstruction where
available, always `approximate` even with a pinned source commit; notes explain
that the recorded SHA-256 could not be reproduced. A prebuilt `source` tar has
no historical source fallback and refuses unless overridden.
Generated inputs spanning multiple repositories or independently pinned input
refs cannot be represented by this one-repository/one-commit history contract
and MUST refuse. Bundle roots whose historical repository prefix cannot be
established also refuse. Feed and bundle extraction MUST use raw tree/blob objects
(`git ls-tree -r -z` and `git cat-file`, with `GIT_ATTR_NOSYSTEM=1`), without
attribute-driven transforms, `export-subst`, or `export-ignore` semantics.
Symlinks MUST be recreated as symlinks and pass the independent escape check;
gitlink/submodule entries MUST refuse with an explicit unsupported-history error.

Fed volumes use a matching record pin with `exact`, `record`, including when no
landing log is retained. Otherwise, lookup inside the inclusive
`[switching_at, landed_at]` window selects the incoming entry with `approximate`,
`landing-log` and an ambiguous-transition note. Outside windows, choose the
newest `landed_at <= effectiveAt`, breaking equal timestamps by last append
(`exact`, `landing-log`). Before the first entry, there is no landed state.

Without selected recorded state, a plain git feed evaluates its ref template
and paths at `effectiveAt`, including `${date}` in UTC and `${date:<IANA zone>}`.
Use the primary ref only if it has an eligible first-parent commit; otherwise
try the fallback. Its newest eligible commit is `approximate`, `feed-rule-at`.
Command refs, directory feeds, prepared/include recipes and freeze/waiting state
cannot be reconstructed this way and refuse. Commit dates do not establish ref
availability or historical freeze holds.

Before choosing retained bytes versus extraction, the selected feed source
commit MUST be verified as a commit object with author AND committer dates
`<= effectiveAt`. This single selection guard applies equally to plain, retained,
prepared, and included git feeds; an eligible landing time does not make a
future source commit eligible. Directory feeds have no git source commit.
Plain git feed bytes MUST come from re-extraction of the landing's expanded paths
at its selected commit, with revision verification using the existing feed
revision function. When retained `trees/<tree name>/` bytes also exist, they MUST
match that extraction (paths, types, executable bits, symlink targets and bytes);
any mismatch refuses. A missing history repository refuses even when retained
bytes exist. Acceptance MUST independently re-extract from the history repository
at the selected commit and paths and compare the bundle bytes and revision.
`include` or `prepare` requires retained bytes; rewind MUST NOT run them.
Prepared revisions identify source/include/recipe provenance, not output content.
When prepared provenance is retained, its composite revision MUST match, and its
git source revision MUST match the selected commit and paths. Prepared output
MUST always be `approximate`, with the note `prepared output not content-verifiable`
and `source.prepared: true` in the moment input (including record-only pins without
a landing log). The independent acceptance gate enforces that fidelity and note.
All leak-check classes still apply to prepared output.
Raw blob extraction ignores repository-local `info/attributes` as well as committed
archive attributes; later tags cannot change historical file bytes.
Output preserves the agent-visible `trees/<tree name>/`, including re-land suffixes, relative `current`
symlink, and `.spawnfile-feed.json` (`spawnfile.volume-feed.v1`). Its `landed_at`
is the selected landing time, or the selected commit's committer time for an
feed-rule approximation. A recorded pin or ambiguous incoming transition may
have publication metadata after `effectiveAt`; this does not advance the trial
clock or filesystem timestamps. The independent gate reopens its record/window
before allowing such publication metadata. Plain directory feeds are not
refetchable: retained tree bytes MUST recompute to the recorded revision or refuse.
Prepared directory bytes MUST NOT be compared to their provenance revision as
though it were a directory content digest.

Memory uses Mneme's single append-only ledger. Any recorded `generation`,
including 0, refuses as unsupported: Mneme has no generations or curation
archives. There is no `generations.jsonl` reader. A record's `seq` selects the
first `seq` ledger lines (`exact`, `record`); `seq:0` is an exact empty bank and
requires no ledger. Otherwise selection stops before the FIRST event after
`effectiveAt` (`approximate`, `created-at-prefix`): a subsequent clock regression
never reopens the cut. The prefix MUST end in LF, contain contiguous sequences
from 1, and only nondecreasing event times `<= effectiveAt`. Legacy seq-less
events are allowed only as a leading run. Invalid sequence or time ordering refuses.

Memory output is `memory/<declaredBy>/<id>/memory/events.jsonl`. It MUST exclude
`index.sqlite`, `causal*`, `authority-receipts.jsonl`, and `authority-receipts/`.
Spawnfile validates the ledger structurally without importing Mneme: every line
MUST be a JSON event with an instant `createdAt`, and duplicate JSON keys refuse.
Sequence, leading legacy run, LF termination, and prefix time ordering are checked
locally. Event checksums are retained but not verified: Mneme 0.1.1 hashes
`JSON.stringify(event)` (`node_modules/@noopolis/mneme/dist/identity/ids.js:15-17`)
before the persisted event normalizes/defaults fields and injects its sequence
(`node_modules/@noopolis/mneme/dist/store/store.js:249-274`); the original input
and its property order cannot be recovered from the ledger alone.

In installed Mneme 0.1.1, the index is rebuilt from the ledger before every index
read: embedding recall at `node_modules/@noopolis/mneme/dist/runtime/runtime.js:86-87`,
`memory.search` at `node_modules/@noopolis/mneme/dist/kernel/kernel.js:152-153`,
and `memory.locate` at `node_modules/@noopolis/mneme/dist/kernel/kernel.js:207-208`.
These sites read the store then call `this.index.rebuildFromEvents(allEvents)`.
Opening an index alone does NOT rebuild it. A materialized bank without
`index.sqlite` is complete because this index is derived state; trial preparation
MUST preserve those rebuild-before-read consumers. Rewind requires no Mneme runtime
dependency and does not create even a temporary index.
Missing bank history refuses unless the bank is overridden or recorded at `seq:0`.

Moltnet JSON and SQLite stores remove messages, rooms, and attachment-delivery
events after `effectiveAt`. Empty threads/DMs and threads/DMs whose root is after the cut
are dropped. Thread/DM message counts and last-message times are recomputed;
attachment cursors are clamped/remapped to retained events. Room removals after
`effectiveAt` are undone when removal time and restorable room metadata exist; a missing
historical removal time retains current removal state. Agents and memberships
have no historical log and are retained as now, explicitly disclosed in input
`notes`: even a cursor-exact content cut cannot prove historical membership.
SQLite changes apply only to a copy through `node:sqlite` on the supported
Node >=22.19 line; if that API is unavailable, SQLite rewind refuses. RFC3339Nano
fractions with omitted trailing zeros MUST be compared as parsed instants.
A record cursor is an instant, MUST equal `wake.startedAt`, and cuts messages at
`created_at <= cursor` (`exact`, `record-cursor`). When `messageIds` is present,
every listed wake message MUST survive the cut; otherwise refuse. With no pin,
cut at `effectiveAt` (`approximate`, `created-at-cut`). Missing stores refuse
unless overridden; UUIDs never order messages.

Unfed volumes consume full point-in-time Daimon trees, not deltas or object
chains. Rows in `recording/<agent slug>/wake-moments.jsonl` use
`noopolis.daimon.wake-moment.v1` with `agent_id`, `execution_id`, `started_at`,
`deliveries`, `snapshots:[{id,snapshot,files,copied,linked,skipped}]`, and optional
`error`. Snapshot names are compact `started_at` plus execution ID (for example
`20261009T082031123Z-execution-17`), but time selection MUST use the row's
`started_at`, not that prefix. A record names its exact snapshot (`exact`,
`record`); otherwise use the newest complete snapshot row `<= effectiveAt`
(`approximate`, `snapshot-at`). `.partial` directories never count. Missing
named history or no complete eligible snapshot refuses.

The sibling manifest contains `{version,id,snapshot,started_at,sourcePath,entries}`.
Entries map relative paths to `{type,mode,size,source,target?}`: type is file,
directory or symlink; size is a decimal string; source preserves recorder
`dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`, and `mode`; target is symlink text.
Copy file bytes into new inodes; do not hard-link into the bundle. Verify paths,
entry types, modes, file/symlink sizes and targets against the manifest; missing
or extra entries refuse. Restore source directory modes (the recorder protects
retained directories as 0700). Directory inode size and copied inode identity
are filesystem metadata, not portable tree invariants. Verify their manifest
structure but not equality to new inodes. Acceptance independently checks the
manifest and compares copied bytes with the retained tree, catching same-size
byte mutations even though recorder manifests contain no content digest.

All materialized files and directories MUST have atime/mtime `<= effectiveAt`, using the
source commit, landing, event, or snapshot instant capped at `effectiveAt`. Symlink times
MUST be set with `lutimes`; following a symlink to set times is insufficient.

### Task clock

`task-clock.json` is strict `spawnfile.task-clock.v1` with `{version, origin}`;
`origin` is `effectiveAt` normalized to ISO-8601 with `Z`. Trial preparation
supplies one safe-integer real launch anchor in milliseconds. All processes MUST
share `originEpochMs + (realNowEpochMs - anchorEpochMs)`; independently started
children MUST NOT reset their clock to the origin. `originEpochMs` uses JavaScript
`Date.parse(origin)` millisecond precision.

Both dataset `at` and selected `effectiveAt` MUST be within the inclusive range
`1970-01-01T00:00:00Z` .. `9999-12-31T23:59:59.999Z`, compared as instants before
millisecond truncation. Out-of-range trials MUST refuse before any materialization
or output creation. This range is shared with Daimon's ecosystem task-clock
contract. Historical source timestamps may precede 1970; filesystem stamping and
restoration MUST preserve their negative epochs using `Date` or numeric-string
arguments to `utimes`/`lutimes`, never negative numeric seconds.

Each process MUST have exactly one offset owner. These pure helpers replace
`taskClockEnvironment`; their outputs MUST NOT be merged for a single process:

| Helper `(origin, anchorEpochMs)` | Recipient | Returned variables |
| --- | --- | --- |
| `harnessTaskClockEnvironment` | Top-level agent harness (Daimon), with an unshifted process clock | Only `NOOPOLIS_TASK_CLOCK`: compact JSON `{"version":"noopolis.task-clock.v1","origin":"<ISO Z>","anchorEpochMs":<int>}` |
| `processClockEnvironment` | Child/tool process under libfaketime | Only `FAKETIME`: signed relative seconds `(originEpochMs - anchorEpochMs) / 1000`, and `FAKETIME_DONT_FAKE_MONOTONIC=1` |
| `clockAwareEnvironment` | Clock-aware child (such as Mneme) without libfaketime | Only `MNEME_CLOCK_ORIGIN`: normalized origin, and `MNEME_CLOCK_ANCHOR_MS`: decimal anchor milliseconds |

Daimon consumes the top-level contract and derives each child's environment itself.
Trial preparation supplies the installed libfaketime path through `LD_PRELOAD` for
the process-clock case. The helper cannot choose an image-specific library path.
That child's environment MUST omit `NOOPOLIS_TASK_CLOCK`, `MNEME_CLOCK_ORIGIN`,
and `MNEME_CLOCK_ANCHOR_MS`, including inherited values. A clock-aware child MUST
instead omit libfaketime from `LD_PRELOAD` and omit `FAKETIME` and
`NOOPOLIS_TASK_CLOCK`. Applying both offsets would shift time twice. The top-level
harness MUST NOT itself run under libfaketime or receive the Mneme offset variables.

Relative `FAKETIME` MUST include a sign, use seconds without a suffix, and preserve
milliseconds (three fractional digits when nonzero; no fraction for integral
seconds). Integer-second rounding and the `@` start-at form are forbidden.
[Upstream libfaketime documentation](https://github.com/wolfcw/libfaketime#readme),
sections 4d/4e, supports fractional signed offsets since 0.8 and notes that the
decimal delimiter depends on locale. Trial preparation MUST ensure a dot-decimal
numeric locale (for example `LC_ALL=C`) for these values.

Shared Spawnfile/Daimon conformance vectors:

| Origin | Anchor epoch ms | `FAKETIME` |
| --- | --- | --- |
| `2001-01-01T00:00:00.000Z` | `1821692800250` | `-843385600.250` |
| `2001-01-01T00:00:00.000Z` | `1821692860250` | `-843385660.250` |
| `2001-01-01T00:00:00.250Z` | `978307200000` | `+0.250` |
| `2001-01-01T00:00:00.000Z` | `978307200001` | `-0.001` |
| `2001-01-01T00:00:00.000Z` | `978307200000` | `+0` |
| `2001-01-01T00:00:00.000Z` | `978307199000` | `+1` |

The clock offsets reported wall time; real timeouts and monotonic elapsed time
MUST remain real. Rewind neither sleeps on nor advances a synthetic scheduler.
Trial preparation owns the anchor and runtime environment; the immutable bundle
carries only the origin.

### Independent leak check and output

The leak checker MUST re-read the bundle from disk independently of materializer
state. Its strict `spawnfile.leak-check.v1` result contains `{version, at, ok,
checked, findings}`; counters cover files, git objects, memory events, Moltnet
messages/events, and snapshots. Each finding carries `{input, class, path,
detail}`; `input` is an input identity or `null` for bundle-level problems.
Metadata is captured before payload reads; the checker restores the captured access
times after inspection, preserving pre-existing future atimes for refusal.
After restoration and rename, filesystem metadata MUST be checked again on the
final published bundle. A failure removes the payload and records the refusal;
the pre-publication check alone cannot establish the published timestamps.
Every git-backed input MUST record its selected full commit ID in
`moment.json`'s `inputs[].source.commit`; git feed identity MUST record the same
ID. Acceptance MUST independently open the source history repository read-only,
verify that ID names a commit object, and inspect its raw author and committer
dates against `effectiveAt`, regardless of retained bytes or normalized filesystem times.
Missing/unreadable provenance and inconsistent feed commit IDs also refuse.
History repositories are resolved by input identity from `--history`. A local
pin or git-backed override resolved without that history entry MUST additionally
record its absolute local repository path in `source.repository`; acceptance
reopens it read-only. That source repository must remain available for subsequent
verification. Directory feeds and digest-pinned or explicitly overridden prebuilt tars have no git
provenance. Recorded bundles are independently checked against their digest-pinned archive. This source check is independent of the materialized git object's
reachable-history check and MUST NOT reuse the producer's date assertion.
Every finding refuses the moment:

| Class | Refusal condition |
| --- | --- |
| `file-time` | A file, directory, or symlink atime or mtime is after `effectiveAt`. |
| `symlink-escape` | An absolute link or a lexically/physically escaping link resolves outside the bundle. |
| `git-object` | Source provenance is missing, inconsistent, not a commit, or has author/committer time after `effectiveAt`; any materialized commit has a future date, any object is unreachable from the selected commit, or refs/remotes/reflogs/fetch metadata exceed the single branch. Any `.git` directory/gitfile or bare repository (`HEAD` + `objects/` + `refs/`) anywhere outside the materialized git resource repository also refuses, including inside feed trees and bundles. |
| `memory-event` | Future ledger events, sequence gaps, invalid prefix ordering, or derived/audit files are present. |
| `moltnet-message` / `moltnet-event` / `moltnet-room` | Retained messages, delivery events, or rooms are after `effectiveAt`. |
| `feed-identity` | Unproved publication time after `effectiveAt`, a directory revision mismatch, or `current` outside its selected tree. |
| `dated-path` | A path segment contains a calendar date `YYYY-MM-DD` later than the UTC date of `effectiveAt + 14h`, the latest possible local date. |
| `snapshot` | An unfed volume differs from its selected full snapshot manifest or retained bytes. |

`OUT` MUST be absent or an empty directory. The materializer builds in a sibling
staging directory and renames into place only after the disk leak check passes:

```text
OUT/
  moment.json
  leak-check.json
  task-clock.json
  resources/<declaredBy>/<id>/...
  memory/<declaredBy>/<id>/memory/events.jsonl
  moltnet/<declaredBy>/<id>/...
```

`moment.json` is strict `spawnfile.materialized-moment.v1`: status, agent,
`example: {id, role, dataset}`, normalized `at`, `effectiveAt`, sorted inputs, and `record: {matched, attempts?,
selectedStartedAt?, executionId?, selection?}`,
and `leakCheck: {ok, findings}`. Inputs sort by section, declaring node, then ID;
each reports kind, fidelity (or `null` on refusal), basis, source identifiers,
relative output path (or `null`), notes, and refusal reason (or `null`). Deferred
bundle builds additionally report `build: deferred`.

On any input refusal or leak, staging is removed and `OUT` contains ONLY
`moment.json` with `status: refused`, all refusal reasons, and `leak-check.json`
if the check ran. Partial input data and task-clock files MUST NOT remain usable.
Success prints `moment.json` to stdout as JSON and exits 0. Refusal emits a
one-line stderr summary and exits 1. Invalid flags, projects, or example
selections can fail before a moment exists and need not create a report.
Generated schemas for the three bundle documents appear below; schema-sync
tests MUST keep them identical to the exported runtime contracts.

## Public handoff

The child invocation is `paideia train --spawnfile-context FILE` followed by the
explicit Paideia options. `FILE` is private evaluator-only JSON, removed after exit.
Dry-run requires neither `--out` nor an optimizer bridge; actual training requires `--out`.
The receiver must save any provenance needed later in its own protected experiment.
The strict `spawnfile.training-context.v1` schema appears below and is generated from
`src/compiler/training/contract.ts`; it is a wire contract, not an internal import API.

Sources cover the full graph's manifests, resolved documents and skill entry files.
Every pin has an absolute `sourcePath`, project-relative POSIX `destinationPath`, and
SHA-256 of the actual file bytes. `destinationPath` preserves source editing locations;
it is **not** a compiled runtime destination. Source files outside the project root
are unsupported in v1. Effective documents retain canonical role order and inheritance.

`project.sourceDigest` is SHA-256 of UTF-8 `JSON.stringify` over the `sources` array
projected to `{destinationPath,sha256}` in that key order, sorted by destinationPath
using code-point lexical order. All digests use the `sha256:` prefix. Absolute roots
do not affect this digest. The receiver must revalidate files and mappings before use.

Resources disclose declaration digests and pins, not mounted or verified archives.
The resource definition digest uses the compiler's recursively key-sorted JSON.
`pin` is the bundle SHA (declared, or hashed for an unpinned prebuilt tar), `bundle-key:<hex>`
for a Spawnfile-built `files` or `dependencies` bundle (the dev cache key for the target
architecture; nothing is built), `bundle-recipe:<hex>` for a `generated` bundle (that key with
tools identified by argv; no command runs), or the Git `ref`; branch/tag-only Git and volumes use null.
This receipt is not a complete packaged-resource closure. No environment values,
transport configuration, resource URLs or credentials are serialized.

`agent.engine` is an explicit runtime engine option or null. Model identity/auth method
use canonical model resolution; absent native model defaults remain null. Runtime-added
instructions, tool schemas, skills loaded at runtime, and native model defaults must be
established from actual compilation/runtime receipts, never invented from this context.

## Execution and outcomes

Dry-run resolves local sources and lets Paideia validate datasets and estimate costs.
It does not compile, use Docker/auth, call models, or start an optimizer. Its final JSON
receipt must have `schema: paideia.training-cost-plan.v1` and `modelCallsMade: 0`.
Unimplemented native preparation is reported as unsupported, not ready to execute.

Actual execution requires a supported preparation integration. Each candidate must
reach native files through Spawnfile compilation; no generic Pi fallback, second agent
declaration or replacement flattened prompt is authorized by this entrypoint. Packaging
exclusion, state isolation and single-agent preparation are not supplied by this handoff.

Repeated options: `--editable`, `--resource`, `--judge`, `--judge-citation-repairs`, `--validation-group`. Other
forwarded options: `--train`, `--test`, `--optimizer-model`, `--bridge-command`, `--out`,
`--max-trials`, `--max-proposals`, `--seed`, `--timeout-ms`, `--view`, `--cost-config`.
The canonical runtime/model/instruction selection cannot be replaced by generic CLI flags.

`--judge-citation-repairs NAME=0|1` is forwarded literally to Paideia. The receiver
requires a matching named judge, unique selections and an exact `0` or `1` before
starting models. Default `0` preserves one judge call per check; `1` reserves one
additional bounded citation repair. It never retries valid quality failures,
authentication/quota failures or malformed JSON. Dry-run records the route policy
and reserves both judge attempts without adding subject trials or optimizer proposals.

Exit 0 requires the mode's final receipt. Completed actual runs also require
`status: completed` and a nonempty `index` path; exit 1 preserves completed failed checks.
Receiver error exits are propagated; empty success is a runtime failure. A supervisor
retains the owned POSIX process-group identity after the native child exits. Cancellation
forwards SIGTERM and escalates after one second; completion also removes group stragglers.
The parent verifies group/output quiescence before returning 0 or cancellation 130/143;
unknown cleanup is a runtime error. No signal uses an identity after its supervisor is reaped.
This delegation requires POSIX process groups; escaped processes and remote effects are not observed.
The child deadline is Paideia's declared deadline plus five seconds for cleanup.

## JSON Schema

<!-- training-context-schema:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "const": "spawnfile.training-context.v1"
    },
    "producer": {
      "type": "object",
      "properties": {
        "package": {
          "type": "string",
          "const": "spawnfile"
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": ["package", "version"],
      "additionalProperties": false
    },
    "project": {
      "type": "object",
      "properties": {
        "root": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "manifest": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "sourceDigest": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        }
      },
      "required": ["root", "manifest", "sourceDigest"],
      "additionalProperties": false
    },
    "agent": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string",
          "minLength": 1
        },
        "source": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "runtime": {
          "type": "string",
          "minLength": 1
        },
        "engine": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "model": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "provider": {
                  "type": "string",
                  "minLength": 1
                },
                "name": {
                  "type": "string",
                  "minLength": 1
                },
                "authMethod": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["provider", "name", "authMethod"],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": ["id", "name", "source", "runtime", "engine", "model"],
      "additionalProperties": false
    },
    "sources": {
      "minItems": 1,
      "maxItems": 10000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "destinationPath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$))[^\\\\]+$"
          },
          "sha256": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          }
        },
        "required": ["sourcePath", "destinationPath", "sha256"],
        "additionalProperties": false
      }
    },
    "documents": {
      "maxItems": 128,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "destinationPath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$))[^\\\\]+$"
          },
          "sha256": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          },
          "role": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": ["sourcePath", "destinationPath", "sha256", "role"],
        "additionalProperties": false
      }
    },
    "skills": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "destinationPath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$))[^\\\\]+$"
          },
          "sha256": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          },
          "name": {
            "type": "string",
            "minLength": 1
          },
          "ref": {
            "type": "string",
            "minLength": 1
          },
          "requiresMcp": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": ["sourcePath", "destinationPath", "sha256", "name", "ref", "requiresMcp"],
        "additionalProperties": false
      }
    },
    "resources": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "type": "string",
            "enum": [
              "bundle",
              "git",
              "volume"
            ]
          },
          "mount": {
            "type": "string",
            "minLength": 1
          },
          "mode": {
            "type": "string",
            "enum": [
              "mutable",
              "readonly"
            ]
          },
          "sharing": {
            "type": "string",
            "enum": [
              "per_agent",
              "team"
            ]
          },
          "definitionDigest": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          },
          "pin": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": ["id", "kind", "mount", "mode", "sharing", "definitionDigest", "pin"],
        "additionalProperties": false
      }
    },
    "requirements": {
      "type": "object",
      "properties": {
        "nativeCompilation": {
          "type": "boolean",
          "const": true
        },
        "isolatedPreparation": {
          "type": "boolean",
          "const": true
        }
      },
      "required": ["nativeCompilation", "isolatedPreparation"],
      "additionalProperties": false
    }
  },
  "required": ["version", "producer", "project", "agent", "sources", "documents", "skills", "resources", "requirements"],
  "additionalProperties": false
}
```
<!-- training-context-schema:end -->

## Training plan JSON Schema

<!-- training-plan-schema:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "const": "spawnfile.training-plan.v1"
    },
    "producer": {
      "type": "object",
      "properties": {
        "package": {
          "type": "string",
          "const": "spawnfile"
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "package",
        "version"
      ],
      "additionalProperties": false
    },
    "project": {
      "type": "object",
      "properties": {
        "root": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "manifest": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        }
      },
      "required": [
        "root",
        "manifest"
      ],
      "additionalProperties": false
    },
    "agent": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "name"
      ],
      "additionalProperties": false
    },
    "record": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "keep": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^[1-9][0-9]*[mhd]$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "volumes": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "declaredBy": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "id",
                  "declaredBy"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "keep",
            "volumes"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "optimizer": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "method": {
              "type": "string",
              "minLength": 1
            },
            "model": {
              "type": "string",
              "minLength": 1
            },
            "variants": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "keep": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "budget": {
              "type": "object",
              "properties": {
                "rounds": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "rounds"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "method",
            "model",
            "variants",
            "keep",
            "budget"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "graders": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "path": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)[^\\\\]+$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "declaredBy": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "sourcePath",
          "path",
          "name",
          "declaredBy"
        ],
        "additionalProperties": false
      }
    },
    "targets": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "declaredBy": {
            "type": "string",
            "minLength": 1
          },
          "grader": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "files": {
            "minItems": 1,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "sourcePath": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                },
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^(?!\\/)[^\\\\]+$"
                },
                "consumers": {
                  "minItems": 1,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              },
              "required": [
                "sourcePath",
                "path",
                "consumers"
              ],
              "additionalProperties": false
            }
          },
          "datasets": {
            "type": "object",
            "properties": {
              "train": {
                "type": "object",
                "properties": {
                  "sourcePath": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?!\\/)[^\\\\]+$"
                  },
                  "examples": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9._-]+$"
                        },
                        "at": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        },
                        "wake": {
                          "type": "object",
                          "properties": {
                            "surface": {
                              "type": "string",
                              "const": "moltnet"
                            },
                            "room": {
                              "type": "string"
                            },
                            "from": {
                              "type": "string"
                            },
                            "text": {
                              "type": "string"
                            }
                          },
                          "required": [
                            "surface",
                            "room",
                            "from",
                            "text"
                          ],
                          "additionalProperties": false
                        },
                        "overrides": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1
                              },
                              "declaredBy": {
                                "type": "string",
                                "minLength": 1
                              },
                              "section": {
                                "type": "string",
                                "enum": [
                                  "resources",
                                  "memory",
                                  "networks"
                                ]
                              }
                            },
                            "required": [
                              "id",
                              "declaredBy",
                              "section"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "id",
                        "at",
                        "wake",
                        "overrides"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "sourcePath",
                  "path",
                  "examples"
                ],
                "additionalProperties": false
              },
              "validation": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "sourcePath": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                      },
                      "path": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "^(?!\\/)[^\\\\]+$"
                      },
                      "examples": {
                        "minItems": 1,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "^[A-Za-z0-9._-]+$"
                            },
                            "at": {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                            },
                            "wake": {
                              "type": "object",
                              "properties": {
                                "surface": {
                                  "type": "string",
                                  "const": "moltnet"
                                },
                                "room": {
                                  "type": "string"
                                },
                                "from": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "surface",
                                "room",
                                "from",
                                "text"
                              ],
                              "additionalProperties": false
                            },
                            "overrides": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "declaredBy": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "section": {
                                    "type": "string",
                                    "enum": [
                                      "resources",
                                      "memory",
                                      "networks"
                                    ]
                                  }
                                },
                                "required": [
                                  "id",
                                  "declaredBy",
                                  "section"
                                ],
                                "additionalProperties": false
                              }
                            }
                          },
                          "required": [
                            "id",
                            "at",
                            "wake",
                            "overrides"
                          ],
                          "additionalProperties": false
                        }
                      }
                    },
                    "required": [
                      "sourcePath",
                      "path",
                      "examples"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "test": {
                "type": "object",
                "properties": {
                  "sourcePath": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?!\\/)[^\\\\]+$"
                  },
                  "examples": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9._-]+$"
                        },
                        "at": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        },
                        "wake": {
                          "type": "object",
                          "properties": {
                            "surface": {
                              "type": "string",
                              "const": "moltnet"
                            },
                            "room": {
                              "type": "string"
                            },
                            "from": {
                              "type": "string"
                            },
                            "text": {
                              "type": "string"
                            }
                          },
                          "required": [
                            "surface",
                            "room",
                            "from",
                            "text"
                          ],
                          "additionalProperties": false
                        },
                        "overrides": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1
                              },
                              "declaredBy": {
                                "type": "string",
                                "minLength": 1
                              },
                              "section": {
                                "type": "string",
                                "enum": [
                                  "resources",
                                  "memory",
                                  "networks"
                                ]
                              }
                            },
                            "required": [
                              "id",
                              "declaredBy",
                              "section"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "id",
                        "at",
                        "wake",
                        "overrides"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "sourcePath",
                  "path",
                  "examples"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "train",
              "validation",
              "test"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "declaredBy",
          "grader",
          "files",
          "datasets"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "version",
    "producer",
    "project",
    "agent",
    "record",
    "optimizer",
    "graders",
    "targets"
  ],
  "additionalProperties": false
}
```
<!-- training-plan-schema:end -->

## Materialized moment JSON Schema

<!-- materialized-moment-schema:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "const": "spawnfile.materialized-moment.v1"
    },
    "status": {
      "type": "string",
      "enum": [
        "materialized",
        "refused"
      ]
    },
    "agent": {
      "type": "string",
      "minLength": 1
    },
    "example": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "role": {
          "type": "string",
          "enum": [
            "train",
            "validation",
            "test"
          ]
        },
        "dataset": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "role",
        "dataset"
      ],
      "additionalProperties": false
    },
    "at": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    },
    "effectiveAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    },
    "inputs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "section": {
            "type": "string",
            "enum": [
              "resources",
              "memory",
              "networks"
            ]
          },
          "id": {
            "type": "string",
            "minLength": 1
          },
          "declaredBy": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "type": "string",
            "enum": [
              "git",
              "bundle",
              "feed",
              "volume",
              "memory",
              "moltnet"
            ]
          },
          "fidelity": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "exact",
                  "approximate",
                  "overridden"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "basis": {
            "type": "string",
            "minLength": 1
          },
          "source": {
            "type": "object",
            "properties": {
              "commit": {
                "type": "string",
                "minLength": 1
              },
              "repository": {
                "type": "string",
                "minLength": 1
              },
              "revision": {
                "type": "string",
                "minLength": 1
              },
              "seq": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "sha256": {
                "type": "string",
                "pattern": "^sha256:[a-f0-9]{64}$"
              },
              "agentSlug": {
                "type": "string",
                "minLength": 1
              },
              "snapshot": {
                "type": "string",
                "minLength": 1
              },
              "cursor": {
                "type": "string",
                "minLength": 1
              },
              "switchingAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
              },
              "landedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
              },
              "prepared": {
                "type": "boolean",
                "const": true
              }
            },
            "additionalProperties": false
          },
          "path": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          },
          "notes": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "refusal": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          },
          "build": {
            "type": "string",
            "const": "deferred"
          }
        },
        "required": [
          "section",
          "id",
          "declaredBy",
          "kind",
          "fidelity",
          "basis",
          "source",
          "path",
          "notes",
          "refusal"
        ],
        "additionalProperties": false
      }
    },
    "record": {
      "type": "object",
      "properties": {
        "matched": {
          "type": "boolean"
        },
        "attempts": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "selectedStartedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
        },
        "executionId": {
          "type": "string",
          "minLength": 1
        },
        "selection": {
          "type": "string",
          "const": "earliest-startedAt"
        }
      },
      "required": [
        "matched"
      ],
      "additionalProperties": false
    },
    "leakCheck": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "findings": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "ok",
        "findings"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "version",
    "status",
    "agent",
    "example",
    "at",
    "effectiveAt",
    "inputs",
    "record",
    "leakCheck"
  ],
  "additionalProperties": false
}
```
<!-- materialized-moment-schema:end -->

## Leak check JSON Schema

<!-- leak-check-schema:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "const": "spawnfile.leak-check.v1"
    },
    "at": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    },
    "ok": {
      "type": "boolean"
    },
    "checked": {
      "type": "object",
      "properties": {
        "files": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "gitObjects": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "memoryEvents": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "moltnetMessages": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "moltnetEvents": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "snapshots": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "files",
        "gitObjects",
        "memoryEvents",
        "moltnetMessages",
        "moltnetEvents",
        "snapshots"
      ],
      "additionalProperties": false
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "input": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "section": {
                    "type": "string",
                    "enum": [
                      "resources",
                      "memory",
                      "networks"
                    ]
                  },
                  "id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "declaredBy": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "section",
                  "id",
                  "declaredBy"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "class": {
            "type": "string",
            "enum": [
              "file-time",
              "symlink-escape",
              "git-object",
              "memory-event",
              "moltnet-message",
              "moltnet-event",
              "moltnet-room",
              "feed-identity",
              "dated-path",
              "snapshot"
            ]
          },
          "path": {
            "type": "string",
            "minLength": 1
          },
          "detail": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "input",
          "class",
          "path",
          "detail"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "version",
    "at",
    "ok",
    "checked",
    "findings"
  ],
  "additionalProperties": false
}
```
<!-- leak-check-schema:end -->

## Task clock JSON Schema

<!-- task-clock-schema:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "const": "spawnfile.task-clock.v1"
    },
    "origin": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    }
  },
  "required": [
    "version",
    "origin"
  ],
  "additionalProperties": false
}
```
<!-- task-clock-schema:end -->
