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

`spawnfile.moment-record.v1` specifies one record per wake; rewind consumes this format,
while the recording phase produces it. Recording MUST be off unless an effective `record` exists,
with zero recording cost when off. `record.keep` is snapshot retention.

```json
{
  "version": "spawnfile.moment-record.v1",
  "agent": "agent:writer",
  "wake": {
    "at": "2026-10-09T08:20:31.000Z",
    "startedAt": "2026-10-09T08:20:31.250Z",
    "executionId": "execution-17",
    "deliveries": [{ "deliveryId": "moltnet:42", "kind": "message", "occurredAt": "2026-10-09T08:20:31.000Z" }],
    "surface": "moltnet", "messageId": "42"
  },
  "recordedAt": "2026-10-09T08:20:32.000Z",
  "exact": true,
  "resources": [
    { "id": "archive", "kind": "git", "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { "id": "tools", "kind": "bundle", "sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  ],
  "feeds": [{ "id": "news", "revision": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "tree": "trees/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.1", "commit": "dddddddddddddddddddddddddddddddddddddddd", "ref": "data/2026-10-09", "paths": ["published"], "landedAt": "2026-10-09T08:00:00.000Z", "period": "2026-10-09" }],
  "memory": [{ "id": "self", "declaredBy": "agent:writer", "seq": 42 }],
  "moltnet": [{ "network": "news", "cursor": "2026-10-09T08:20:31.250Z", "messageIds": ["42"] }],
  "volumes": [{ "id": "edition-state", "snapshot": "incremental-snapshot-17" }]
}
```

### Host histories and retention

`record.keep` bounds landing logs, deploy logs, snapshots and moment records; omission
means **30d**. A shared history MUST use the maximum effective keep among its recording
consumers (all recording agents for the deploy log). History-log pruning MUST keep entries newer
than `now - keep` AND the newest entry at or before that cutoff, even across a long gap.
Lookups are inclusive; equal timestamps use the last appended entry. Before the first
entry, lookup returns no state. Invalid lines MUST be reported alongside valid entries.

For each fed volume consumed by a recording agent, the host MUST append
`landings.jsonl` beside `landed.json` after each successful land, generation re-land,
retained-tree re-point or link repair. Provenance/period adoption MUST also be logged.
Before ANY replacement of `landed.json` (including revision advances, re-points,
repairs and adoption), the publisher MUST reconcile its previous recording snapshot
against the last log entry and append it if missing, preserving the original instant.
A failed reconciliation MUST prevent replacement. A clean refresh also seeds history
when recording is enabled later. Recorded host state retains the original source and
keep window so a changed source declaration cannot rewrite pending provenance.
The entry MUST follow a successful `landed.json` write and contain:
`{version:"spawnfile.volume-feed-landing.v1", resource, volume, revision, tree,
source, commit?, ref?, paths?, switching_at, landed_at, period?}`. `switching_at`
MUST be sampled immediately BEFORE the `current` rename, including link repair;
`landed_at` remains the post-switch instant and MUST equal
`identity.landed_at`; `period` is the host record's period. `source` MUST identify
`{kind:"git", repo}` or `{kind:"directory", directory}` and preserve any `prepared`
provenance. Git entries MUST carry the resolved commit and expanded requested ref;
`paths`, when present, MUST be the expanded git paths. Commit, paths and revision
permit refetch and verification without retaining trees. Directory feeds are verifiable
by revision digest but **not refetchable**. Prepared feeds also require their recorded
include digests and recipe inputs; a revision does not promise reproducible prepare output.
Lookup inside either endpoint of `[switching_at, landed_at]` MUST return the incoming
entry plus `ambiguous:true`. Outside transition windows, select the most recent
`landed_at <= instant`. Adoption without a content switch uses `switching_at = landed_at`;
old nonrecorded identities seeded on opt-in use the same degenerate window. Recording
history missing a required transition boundary is invalid, never assumed exact.

When any compiled agent records, project `up` and home deployment publication
(including image `up` and release) MUST append a resource log beside their record:
`<output>/deployments/<name>.resource-log.jsonl` for project records, and
`~/.spawnfile/deployments/<name>/resource-log.jsonl` for home records. `deployment_id`
is the absolute canonical record path; lookup MUST require that identity. Independent
outputs with the same deployment name MUST NOT share history or retention.

Each `{version:"spawnfile.deploy-resources.v1", deployment, deployment_id, activated_at,
activation_exact, activation_note?, deployed_at, report_sha256, resources, recording_agents}` entry MUST
reuse `workspace_git_resources` and `workspace_bundles`, without resolving sources again.
`recording_agents` MUST copy the validated compiled recording facts for every recording
agent: node ID, slug, recording directory, keep window, snapshot IDs, consumed feed IDs
and volume names, git/bundle resource IDs, memory bank IDs with declaring node and ledger
path, and attached Moltnet networks. These facts survive releases that remove or change
inputs. Legacy entries without them remain readable but cannot produce exact moments.
Every resource MUST retain its workspace-visible `id`, compiled `agent_node_ids`, and
`declared_by` node ID when known. Git adds `{kind:"git", commit, sha256, url?}`; bundles
add `{kind:"bundle", sha256, origin?}`. Ownership MUST survive compile and distribution
projection, including equal IDs/digests with different commits. Image pins omit host
paths and source URLs. Unowned legacy history MUST be reported as invalid, never guessed.
With no effective recording agent, compile reports MUST omit `agent_node_ids` and
`declared_by` and preserve the original resource deduplication and serialized shape.

Lookups and retention MUST use `activated_at`; `deployed_at` is informational record
creation time. Activation ordering is path-specific:

- Image `up` renames/stops the previous container, verifies it stopped, then samples
  `activated_at` immediately before `docker run`. It waits for a later host-clock tick
  than the stopped observation, so no old turn can have an equal timestamp.
- Drained release first closes admission and waits for old turns, then calls image `up`
  under the home lock; the same stop/verify/activation/start sequence applies.
- Project `up` samples immediately before invoking its launch runner. First deployment
  has no recorded predecessor. Replacement does not stop/drain its predecessor and MAY
  overlap it: entries MUST set `activation_exact:false` with `activation_note`. Records
  without a captured launch boundary (including recovered launches) are likewise inexact.

If a started candidate is removed on readiness or publication failure, image `up`,
release and project `up` MUST append its pins with `{activated_at, rolled_back_at,
exact:false, activation_exact:false}`. `rolled_back_at` is sampled after candidate
removal, before restoration where applicable. This interval MUST NOT replace the
predecessor's authoritative record. Lookup inside the inclusive interval returns the
candidate with `exact:false`, even if it previously published a successful-looking
snapshot; after the interval, that snapshot is excluded and the predecessor applies
until another deployment activates. Retention MUST preserve intervals crossing the
cutoff and the predecessor needed after rollback. No candidate history is written when
recording is off. A failed candidate cleanup MUST NOT invent a completed rollback.
These interval entries describe execution and removal, not successful publication;
their append follows removal without requiring a new authoritative deployment record.

The host clock MUST remain monotonic across these operations. Containers MUST share
that clock; remote clock skew invalidates exact reconstruction. A moment arriving before
publication MUST wait for its authoritative deployment record/history, or be inexact.

The deployment record MUST persist `recording: {keep_ms, memory_mount_ids}` and its
complete `resource_snapshot`, including the hash of the exact persisted UTF-8 report
bytes. Before replacing a deployment record OR its cached report, the publisher MUST
reconcile that snapshot against the last log entry. Reconciliation failure MUST abort
replacement. Recompilation MUST preserve deployment records/history, including clean
compiles; it cannot erase a pending snapshot. Retried publication of the same snapshot
MUST NOT append a duplicate. Turning recording off still reconciles an owed predecessor.
Writers MUST receive predecessor metadata from the lifecycle's existing record read;
only effective recording or a recorded predecessor permits additional record reads.

Host records and cached deployment reports MUST be published by file fsync, rename,
and parent-directory fsync BEFORE log append. Both logs MUST append each complete JSON
line in one write followed by file and directory fsync. Pruning MUST use an exclusive
0600 temporary file, file fsync, rename and directory fsync under a writer lock.
With recording off and no recorded predecessor, neither log nor its lock may be touched.
Host-record/report writes in that case MUST retain their original write/rename sequence,
permissions and bytes, without added reads, durable writes or fsyncs. A matching last
log line MUST still be file- and directory-fsynced before reconciliation succeeds:
visibility alone does not prove a previous failed append became durable.
A deploy-log failure after publication MUST be reported without rolling back the
container named by the published deployment record.
If record rename succeeds but directory fsync fails, the named container MUST also
remain; no log entry may be appended until the authoritative record is re-synced.

Spawnfile MUST enforce memory protection from the DEPLOYED record's `recording`
metadata, independent of later compile settings. For recorded state, teardown with volume deletion MUST
refuse a changed report fingerprint, missing protected mount, reduced keep, or dropped
recording/mount protection unless explicitly overridden. `down --volumes --discard-recorded-memory`
is that override; `--force` alone is insufficient. Author-declared shared volume names
remain retained under the existing teardown rule. Internal fixture cleanup MUST apply
the same guard. Spawnfile has no memory-ledger reset/prune command; release prunes only
images. This guarantee covers Spawnfile's deletion paths, not external Docker commands.
Mneme stays independent and its ledger MUST NOT be truncated by recording retention.

Rewind MUST use records when present; otherwise it is best effort and the trial MUST
be labelled as such.

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

The history consumer layout is normative:

```text
DIR/
  moments/*.jsonl
  git/<declaredBy>/<id>/
  feeds/<declaredBy>/<id>/landings.jsonl
  feeds/<declaredBy>/<id>/repo/
  feeds/<declaredBy>/<id>/trees/<revision>/
  memory/<declaredBy>/<id>/events.jsonl
  memory/<declaredBy>/<id>/generations.jsonl
  moltnet/<declaredBy>/<id>/state.json | moltnet.sqlite
  volumes/<declaredBy>/<id>/snapshots.jsonl
  volumes/<declaredBy>/<id>/objects/<sha256>
```

`<declaredBy>` MUST be `encodeURIComponent` of the node ID: `agent:writer`
becomes `agent%3Awriter`. IDs and content-addressed names MUST be safe path
segments. Every read MUST remain inside `DIR` both lexically and after realpath
resolution; symlink escapes MUST refuse. History repositories MAY be bare or
ordinary repositories and MUST remain unmodified. Every JSONL line MUST be
validated strictly; an invalid line MUST refuse affected inputs and identify
the history file, line, and reason. History writers use these line shapes:

- `moments/*.jsonl`: one `spawnfile.moment-record.v1` object per line, any filename.
- `landings.jsonl`: `{revision, tree, commit, ref, paths, landedAt}`.
  `revision` is the lowercase 64-hex feed digest; `tree` names that revision,
  optionally with its re-land generation or `trees/` prefix. Directory sources
  use `null` commit/ref/paths; git sources require commit/ref, with `null` or `[]`
  paths denoting the whole tree.
- OPTIONAL `generations.jsonl`: `{generation, switchedAt, ledger}`, with `ledger`
  relative to that bank's directory and naming its current or archived ledger.
- `snapshots.jsonl`: `{snapshot, takenAt, parent, files}`, where `parent` is a
  snapshot ID or `null`; `files` maps changed relative paths to SHA-256 digests or
  `null` for deletion. `objects/<sha256>` contains each referenced file's bytes.

Moment records match when `agent` equals the plan agent ID and `wake.at` is the
same parsed instant as example `at`; different offset spellings are equivalent.
Several matching records MUST agree in every field used for the selected
inputs, otherwise the moment refuses. No matching record triggers each input's
fallback rule. Fallbacks are labelled `approximate`; independent immutable pins
and landing logs retain the exact fidelity specified below. All timestamp
comparisons MUST compare instants, preserving RFC3339 nanoseconds where present,
never timestamp strings or UUID order. Boundary instants equal to `at` are included.

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

Git resources and source-backed bundles select a full 40- or 64-hex declared
commit first (`exact`, `pinned`), otherwise the matching record's resource
commit (`exact`, `record`). Otherwise they walk the declared selector's
first-parent history and choose its newest commit with committer time `<= at`
(`approximate`, `selector-at`); an absent selector means `HEAD`. Commit dates
do not establish when a commit reached a branch or tag, so this fallback cannot
prove historical ref membership. A missing eligible commit refuses.

Git output MUST be a clean new repository containing only objects reachable
from the selected commit, with one checked-out branch, no remotes, tags, source
packed refs, reflogs, `FETCH_HEAD`, or `ORIG_HEAD`. Git commands use argv without
a shell and sanitized configuration. History MUST NOT be mutated. The leak
check also rejects any reachable ancestor with author or committer time after
`at`. Bundle `build.files` extracts `files.root` at the selected commit and honors
`exclude`. `build.dependencies` and `build.generated` retain their source
directory or declared inputs at that commit and report `build: deferred`;
trial preparation owns builds. Bundle output MAY be a plain tree. A prebuilt
`source` tar without a record or explicit override is un-rewindable and refuses.
Generated inputs spanning multiple repositories or independently pinned input
refs cannot be represented by this one-repository/one-commit history contract
and MUST refuse. Bundle roots whose historical repository prefix cannot be
established also refuse. Bundle file trees preserve the existing compiler's
symlink refusal; excluded symlinks do not need materialization.

Fed volumes select the newest landing with `landedAt <= at` when a landing log
exists (`exact`, `landing-log`); no eligible landing refuses. A matching record
feed entry MUST agree with that landing. Without a log, a plain git feed expands
its ref template and paths using `at`, including `${date}` in UTC and
`${date:<IANA zone>}` in that zone. The primary ref is used only if it has an
eligible first-parent commit; otherwise the declared fallback is tried. Its
newest eligible commit is `approximate`, `feed-rule-at`. Commands, directory
feeds, and freeze/waiting behavior cannot reconstruct historical landings
without a log and MUST refuse. Ref dates alone do not capture earlier freeze
holds or when a producer made a ref available.

Feed bytes come from OPTIONAL retained `trees/<revision>/` when available.
Otherwise a plain git feed re-extracts the landing's expanded paths at its commit
and MUST verify the revision with the existing feed revision function. A mismatch
refuses. `include` or `prepare` requires retained bytes; rewind MUST NOT run them.
Unrecorded repository-local `info/attributes` also requires retained bytes;
reconstruction otherwise honors the commit's archive attributes.
Output preserves the agent-visible `trees/<revision>/`, relative `current`
symlink, and `.spawnfile-feed.json` (`spawnfile.volume-feed.v1`). Its `landed_at`
is the selected landing time, or the selected commit's committer time for an
approximation, always `<= at`.

Memory selects the generation with greatest `switchedAt <= at`, refusing if
the generation log contains none or its archived ledger is unavailable. Without
a generation log, the sole current ledger is treated as original generation 0;
a record naming another generation refuses. A matching record MUST name the
selected generation. Its `seq` selects the first `seq` ledger lines (`exact`,
`record`). Otherwise selection stops before the FIRST event after `at`
(`approximate`, `created-at-prefix`): subsequent clock regression never reopens
the cut. The prefix MUST end in LF, contain contiguous sequences from 1, and
contain only nondecreasing event times `<= at`. Legacy seq-less events are
allowed only as a leading run. Invalid sequence or time ordering refuses.

Memory output is `memory/<declaredBy>/<id>/memory/events.jsonl`. It MUST exclude
`index.sqlite`, `causal*`, `authority-receipts.jsonl`, and `authority-receipts/`.
The installed Mneme 0.1.1 package publicly exports `createMemoryIndex`; rewind
rebuilds a temporary index from the selected ledger through this root API,
verifies it can be queried, then discards it. No deep imports are permitted.
Mneme rebuilds from its ledger before kernel searches; opening an index alone
does NOT rebuild it. Trial preparation must retain that search/rebuild behavior.
Mneme remains a development dependency: if its public rebuild API is unavailable,
historical memory materialization refuses explicitly without auto-installing it.
Missing bank history also refuses unless the bank is overridden.

Moltnet JSON and SQLite stores remove messages, rooms, and attachment-delivery
events after `at`. Empty threads/DMs and threads/DMs whose root is after the cut
are dropped. Thread/DM message counts and last-message times are recomputed;
attachment cursors are clamped/remapped to retained events. Room removals after
`at` are undone when removal time and restorable room metadata exist; a missing
historical removal time retains current removal state. Agents and memberships
have no historical log and are retained as now, explicitly disclosed in input
`notes`: even a cursor-exact content cut cannot prove historical membership.
SQLite changes apply only to a copy through `node:sqlite` on the supported
Node >=22.19 line; if that API is unavailable, SQLite rewind refuses. RFC3339Nano
fractions with omitted trailing zeros MUST be compared as parsed instants.
A record cursor yields `exact`, `record-cursor` only if it identifies a retained
message and no retained message is later than that cursor's message. Otherwise
fidelity is `approximate`, `created-at-cut`. Missing stores refuse unless overridden.

Unfed volumes choose the newest snapshot with `takenAt <= at`. A record MUST
name that snapshot or an ancestor-consistent exact snapshot; a valid record is
`exact`, otherwise selection is `approximate`. The full parent chain is replayed
from its root, including deletions, and every copied object is SHA-256 verified.
Missing history, missing parents/objects, or no eligible snapshot refuses.
Materialized content must equal the replayed snapshot, checked independently.

All materialized files and directories MUST have atime/mtime `<= at`, using the
source commit, landing, event, or snapshot instant capped at `at`. Symlink times
MUST be set with `lutimes`; following a symlink to set times is insufficient.

### Task clock

`task-clock.json` is strict `spawnfile.task-clock.v1` with `{version, origin}`;
`origin` is the example instant normalized to ISO-8601 with `Z`. The pure helper
`taskClockEnvironment(origin, anchorEpochMs)` accepts a caller-supplied safe
integer real launch anchor in milliseconds and returns these string variables:

| Variable | Value |
| --- | --- |
| `NOOPOLIS_TASK_CLOCK` | Compact JSON `{"version":"noopolis.task-clock.v1","origin":"<ISO Z>","anchorEpochMs":<int>}` |
| `MNEME_CLOCK_ORIGIN` | The same normalized origin |
| `MNEME_CLOCK_ANCHOR_MS` | Decimal anchor milliseconds |
| `FAKETIME` | `@YYYY-MM-DD HH:MM:SS`, expressed in UTC |
| `FAKETIME_DONT_FAKE_MONOTONIC` | `1` |

Daimon consumes the cross-repository `noopolis.task-clock.v1` contract: reported
agent wall time is `origin + (realNow - anchorEpochMs)`. Mneme consumes its generic
clock variables. The libfaketime values take effect only in capable images with
`LD_PRELOAD` configured by trial preparation. The clock offsets reported wall
time; real timeouts and monotonic elapsed time MUST remain real. Rewind neither
sleeps on nor advances a synthetic scheduler. Trial preparation owns the anchor
and runtime environment; the immutable bundle carries only the origin.

### Independent leak check and output

The leak checker MUST re-read the bundle from disk independently of materializer
state. Its strict `spawnfile.leak-check.v1` result contains `{version, at, ok,
checked, findings}`; counters cover files, git objects, memory events, Moltnet
messages/events, and snapshots. Each finding carries `{input, class, path,
detail}`; `input` is an input identity or `null` for bundle-level problems.
Every finding refuses the moment:

| Class | Refusal condition |
| --- | --- |
| `file-time` | A file, directory, or symlink mtime is after `at`. |
| `symlink-escape` | An absolute link or a lexically/physically escaping link resolves outside the bundle. |
| `git-object` | Any commit author/committer time is after `at`, any object is unreachable from the selected commit, or refs/remotes/reflogs/fetch metadata exceed the single branch. |
| `memory-event` | Future ledger events, sequence gaps, invalid prefix ordering, or derived/audit files are present. |
| `moltnet-message` / `moltnet-event` / `moltnet-room` | Retained messages, delivery events, or rooms are after `at`. |
| `feed-identity` | `landed_at` is after `at` or `current` does not target a tree inside the volume. |
| `dated-path` | A path segment contains a calendar date `YYYY-MM-DD` later than the UTC date of `at + 14h`, the latest possible local date. |
| `snapshot` | An unfed volume differs from its selected replayed snapshot. |

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
`example: {id, role, dataset}`, normalized `at`, sorted inputs, `record: {matched}`,
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
              "revision": {
                "type": "string",
                "minLength": 1
              },
              "seq": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "generation": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "snapshot": {
                "type": "string",
                "minLength": 1
              },
              "cursor": {
                "type": "string",
                "minLength": 1
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
