# Training in one container

`spawnfile train` runs the complete model-bearing experiment in one immutable
Docker image: Paideia, DSPy, the integration, Daimon and inference CLIs. The host
validates declarations, mounts explicit inputs, forwards output and supervises
container termination. No Docker socket enters the container. Dry-run remains a
host-only estimate and does not use Docker or model authentication.

## Launch contract

The advanced v1 path requires both `--training-image` (a digest reference or immutable
image ID already installed locally) and `--training-config` (JSON below).
`--paideia-command` applies only to dry-run; actual execution always starts the
image-owned `/opt/training/bin/train`. No shell or executable from the host is
mounted or selected. The image must contain all dependencies and its integration.

```json
{
  "version": "spawnfile.training-container.v1",
  "dockerContext": "desktop-linux",
  "inputs": [
    { "source": "/absolute/project", "destination": "/run/training/inputs/project" },
    { "source": "/absolute/evaluation", "destination": "/run/training/inputs/integration" }
  ],
  "output": { "source": "/absolute/generated/run", "destination": "/run/training/output" },
  "auth": [
    { "source": "/absolute/credential-leaf", "provider": "codex" }
  ]
}
```

All sources must already exist at exactly canonical paths (no `..`, redundant
separators or symlink aliases). Host input roots must not overlap. Inputs are read-only and
cannot overlap the writable output root. Auth declarations accept only regular
leaf files, mounted read-only at `/run/paideia-auth/<provider>`; no whole CLI home
or configuration directory is accepted. This checks declared paths, not arbitrary
secret contents inside user-selected input bytes. Input roots must contain only
the experiment's intended source and evidence.

The selected Docker context must resolve to a local Unix socket. Remote daemon
bind staging is unsupported. The launcher resolves the pinned image before
creating a uniquely labelled container, then uses the immutable image ID.

The image entrypoint receives:

```text
/opt/training/bin/train train --spawnfile-context /run/paideia/context.json ...
```

Canonical context source paths and CLI dataset/resource/output paths are mapped
through the declared bindings. YAML-relative data paths continue to resolve in
that mapped dataset tree. Absolute paths embedded inside integration settings or
YAML must already use container paths; the launcher does not rewrite arbitrary
file contents. Bridge executables must already exist under `/opt/training`.
Runtime `HOME=/home/training`, `/tmp` and `/work` are fresh writable tmpfs mounts;
the image root is read-only. Launch uses the non-root host uid/gid, drops all
capabilities and keeps no-new-privileges. The existing Codex native namespace
compatibility options disable the outer seccomp/AppArmor profiles; native sandbox
preflight must still verify the agent boundary before cognition. Image startup
owns its runtime configuration.

`--view <port>` accepts one explicit port from 1 to 65535 and publishes it only
on host `127.0.0.1` at that same port. Port zero is unsupported in container mode.
The trusted image integration binds its Paideia viewer to the container interface;
public URLs still use host loopback. Removing the owned container removes that
port mapping. Persisted events also remain available for later local replay.

## Native subscription bootstrap

The public `spawnfile/auth` module exports `stageTrainingAuth({home,provider,source?})`.
It copies opaque bytes from `/run/paideia-auth/<provider>` by default into an
existing canonical runtime home. An explicit provisioned source leaf is accepted.
It creates only the fixed private directory and native auth leaf, never overwrites
an existing or refreshed credential, and returns a non-secret versioned receipt.

| Provider | Destination relative to runtime home |
| --- | --- |
| codex | `.daimon-inbound/codex-auth` |
| claude | `.claude/.credentials.json` |

Grok is not stageable and `grok` is not an `auth` provider: the one training
Grok login lives in the broker-owned realm volume of a v3 container and is spent
through inference grants, never copied into a runtime home.

The image startup can stage Claude into its clean shared home. A native trial
preparation callback stages Codex into that trial's fresh home before Daimon
starts. Credentials remain writable only inside the runtime home; renewed state
is not silently copied back to the host bootstrap file.

## Completion and cancellation

The host forwards container stdout/stderr and requires the final Paideia training
receipt, a matching stopped container exit status, and a real completion artifact
within the declared output root. A successful `docker create` or client exit alone
never means the experiment completed.

Cancellation and timeout stop the Docker client and force-remove only a container
whose exact ID, unique ownership label, name and image match. Absence is checked
through a successful Docker listing. Unknown cleanup is an error and preserves
its private mounted context for diagnosis; it is never reported as quiescent.

This is a single-container boundary. Native Daimon sandbox policy still controls
individual agent access inside it. The image build, usable private integration,
authenticated model run and live terminal receipt require end-to-end verification
before calling this deployment ready.

## Declarative preparation (v2)

Use the same command with `--training-config evals/training.json`; v2 owns the
image, so omit `--training-image`. `--train`, `--out`, `--resume` and `--view`
retain their meanings. Docker must already be available in the named local
context. The command does not configure or start a machine-global VM.

```json
{
  "version": "spawnfile.training-container.v2",
  "dockerContext": "desktop-linux",
  "image": {
    "build": {
      "recipe": "daimon-dspy.v1",
      "nativeImage": "registry.example/native@sha256:<64 hex characters>",
      "pythonImage": "docker.io/library/python@sha256:<64 hex characters>",
      "platform": "linux/arm64",
      "paideia": "./packages/paideia",
      "bridge": "./packages/dspy",
      "claude": "./packages/claude",
      "integration": { "source": "./integration", "entry": "container/entry.ts" },
      "bootstrap": "./bootstrap"
    }
  },
  "integration": { "settings": { "input": "evals", "path": "settings.json" } },
  "inputs": [
    { "id": "project", "source": "../project", "destination": "/run/training/inputs/project" },
    { "id": "evals", "source": ".", "include": ["settings.json", "train.paideia.yaml", "test.paideia.yaml"], "destination": "/run/training/inputs/evals" }
  ],
  "output": { "source": "../runs/author", "destination": "/run/training/output" },
  "auth": []
}
```

Replace digest placeholders with verified immutable pins. This recipe supports
Daimon with DSPy only; it does not promise other native runtime layouts.
`bootstrap` is optional: omit it when the installed integration builds its own
verified runtime bootstrap from maintained source inside the writable output. An
already-built image can instead use `"image": {"ref": "sha256:..."}`.

Source paths resolve relative to the config file. The output parent must exist;
the command creates the output and its private preparation directory. Plain
inputs are readonly bindings. `include` stages only declared files/subtrees,
preserving their paths, and avoids mounting historical runs or host dependencies.

A Git input may declare `"git": {"revision": "<full commit>", "overlays":
[{"source": "./generated/tools.tar", "path": "tools.tar", "sha256": "sha256:..."}]}`.
Its source must be a repository root. Spawnfile creates a self-contained pinned
Git snapshot and adds new hash-verified generated files. It never copies a
worktree's `.git` pointer or overwrites tracked files. The selected canonical
agent's pinned source bytes must match that snapshot. Confined internal links
are supported; escaping links and submodules are rejected. Git and local
`include` modes are separate.

Build staging includes explicit distributions, locks, the installed Spawnfile,
and its packaged recipe. Local `file:`/link dependency closures are unsupported
and fail before building; provide complete registry-locked distributions instead.
The recipe supplies the Daimon peer from its native parent. Credentials and
datasets never enter the image context. Cache identity includes actual source,
lock, executable and recipe bytes, parent images, architecture and entrypoint;
reuse also verifies the image ID and recipe label in the selected Docker context.

### Native parent and Daimon runtime identity

`image.build.nativeImage` and `SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY` are two
independent pointers at one run, and they never carry the same digest: the local
Daimon runtime image ends in `FROM scratch`, so the identity always attests a
scratch image that a runnable native parent copies
`/opt/spawnfile/runtime-installs/daimon` out of. Preparation therefore binds them
by content, not by digest equality.

Before any Docker call, and before `--dry-run` returns, preparation loads the
identity when that variable is set and refuses when its `manifest_sha256` is not
the compiler's contract pin, when `image_architecture` disagrees with
`image.build.platform`, or when a `127.0.0.1:<port>` native parent is declared
with no identity at all. It then makes the first instruction of the native stage
verify that the parent's own `capability-receipt.json` and
`contract-manifest.sha256` are exactly the ones the identity attests, refusing
with both file paths and both digests named. The recipe text is part of the image
plan digest, so a rotated identity can never be satisfied by a cached image. A
published (non-loopback) native parent with no identity keeps its previous
behaviour.

Staged build contexts normalize modes and times before `docker build`: directories
0755, files `a+rX`-closed, both entrypoints (`train`, `train-broker`) 0555, mtimes
fixed. Together
with the recipe's change-only `a+rX` closure this reproduces the former recursive
chmod's in-image modes without a whole-tree RUN after every distribution copy
(`runtime-images/training/AGENTS.md`). The recipe text is part of the image digest,
so this change rebuilds existing training images once.

The installed integration reads `/run/paideia/preparation.json` using
`parseTrainingMappedPreparation` from `spawnfile/training`. This protected
`spawnfile.training-preparation.v1` receipt contains the preparation digest,
immutable image ID, named container bindings, output root, installed package
paths and the input-relative settings reference. It contains no host paths or
credentials. The integration resolves its own typed settings; Spawnfile never
rewrites arbitrary JSON strings or invokes a host project preparation script.

Dry-run hashes and validates local inputs but performs no Docker, auth or
preparation writes. Exact resume checks current source identity and preserved
snapshots/receipts, then requires the saved immutable image. It never rebuilds
a replacement under an existing experiment identity. Paideia independently
checks its experiment checkpoint and cumulative budgets.

## Explicit measurement repair fork

`spawnfile train PROJECT --training-config evals/training.json --train evals/train.paideia.yaml --out runs/repair --repair-measurements runs/parent`
creates a new experiment from captured work. The declaration's output must match
`--out` and be fresh/disjoint. It does not weaken ordinary `--resume`. To resume
this child, retain the same repair arguments and add `--resume`.

V2 builds now seal an automatic `spawnfile.training-witness.v1` beside their
preparation state, including exact image input bytes, recipe, input identities and
canonical context. Legacy parents require `--repair-witness /path/manifest.json`:
its envelope, complete copied image closure, original preparation digest and
installed parent image's recipe label must all verify. A caller's unverified image
name or compatibility assertion is insufficient. Image-reference-only declarations
cannot establish this compatibility and reject repair.

The `daimon-dspy.v1` recipe supports optional `image.build.compiler`, a complete
registry-locked Spawnfile distribution used only for native compilation under
`/opt/training/compiler`. Omission uses the current installed compiler. Repair may
pin the parent's original compiler while using corrected evaluation/launch code.
The mapped preparation receipt supplies that exact compiler executable path.

`spawnfile.daimon-dspy-compatibility.v1` requires unchanged native/Python images,
platform, compiler closure, installed integration, native adapter/trial code,
canonical source and every declared input digest/binding. Optimizer Python and
locks stay pinned; only checkpoint/protocol import plumbing and documentation may
change. Generated `.coverage`, `.pytest_cache` and `coverage.json` are excluded
explicitly, never arbitrary dotfiles. Paideia separately verifies candidate,
criteria, budgets, splits, native capture closure and repair eligibility.

Only `runs/`, `blobs/` and the four command/training/host/optimizer checkpoint JSON
files are copied into a sealed read-only parent projection. Runtime homes, auth,
mutable caches and invocation databases are excluded. The exact projection manifest
and checkpoint bytes are hashed. `/run/paideia/repair.json` is a protected read-only
`paideia.measurement-repair.v1` receipt; the launcher forwards its fixed path via
`--repair-context` together with `--repair-measurements /run/training/inputs/repair-parent`. Both refer to the verified read-only projection; no host paths or credentials are forwarded.
Paideia owns error-only rescoring, retaining successful historical pass/fail results,
paired optimizer import, cumulative accounting and the new experiment lineage.
A repair receipt does not itself assert that any judgment or continuation succeeded.

## Broker-capable training (v3)

`spawnfile.training-container.v3` is v2 plus one brokered Grok slot, so the
subject's model runs beside the evaluator in the same container instead of
reaching a model the evaluator also holds. It is selected by adding a `broker`
block to the declarative preparation; everything else in v2 is unchanged.

```json
{
  "version": "spawnfile.training-container.v3",
  "broker": {
    "engine": "grok",
    "agentId": "agent:author",
    "model": "grok-4.6",
    "reasoningEffort": "low",
    "architecture": "arm64",
    "limits": { "maxRequests": 32, "maxTokens": 300000, "timeoutMs": 240000 },
    "realmVolume": "spawnfile-training-grok-realm",
    "bootstrap": "./secrets/paideia-training-grok/auth.json",
    "unenforcedBindPolicy": "refuse"
  }
}
```

`image.build.grok` is refused under v3 and ignored under v2: the image copies no
Grok binary at all, and the `grok` auth provider is gone from `auth` and from
`stageTrainingAuth`. Judges run the native parent's pinned `/usr/local/bin/grok`
through a broker inference grant, so there is exactly one Grok build and exactly
one Grok credential in the container.

### Privilege table

| Process | uid | Capability bounding set | Where it comes from |
| --- | --- | --- | --- |
| container | 0 | `CHOWN,SETUID,SETGID,SETPCAP,KILL,DAC_READ_SEARCH` | `docker create` (`no-new-privileges`, read-only root, pids 2048) |
| root entrypoint | 0 | same | image `/opt/training/bin/train-broker` |
| engine broker launcher | 0 | `CHOWN,SETUID,SETGID` (`…c1`) | `setpriv --bounding-set` |
| engine broker backend | 2100 | empty | `setpriv --reuid 2100` |
| control relay | 2100 | empty | `setpriv --reuid 2100` |
| slot supervisor | 0 | same as the entrypoint | in-process with the entrypoint |
| `train` — Paideia, DSPy, judges | 2000 | empty, verified from `/proc/self/status` | `setpriv --bounding-set=-all` |
| model tools | 2200 | empty | the native launcher alone can `setuid` there |

`CAP_FOWNER` and `CAP_DAC_OVERRIDE` are deliberately absent, so provisioning
always reclaims an inode before it chmods one, creates every directory while the
tree is still root-owned, and sets ownership from the deepest path upwards.

Grok 1.0.34 runs every sandbox profile inside bubblewrap, so the container adds
the pinned `seccomp-default-plus-userns` profile and `apparmor=unconfined`, and
the Docker host must allow unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=0`); the entrypoint refuses to
provision a slot otherwise, naming that sysctl.

### Slot lifecycle

Every per-trial path is tmpfs, never the realm volume: the worker home, the slot
workspace, the agent runtime home and its setgid `tool-output/`, the
wake-acceptance store, the broker turn store, and the per-slot usage ledger. The
realm volume holds only `auth.json` and the broker credential journal, so an
identical `(agent, wake, prompt)` in trial N+1 can never replay trial N's sealed
turn.

The root slot supervisor listens on `/run/training/supervisor/control.sock` with
one verb and one argument:

```json
{"v": "spawnfile.training-slot-supervisor.v1", "verb": "recycle", "nonce": "<32 random bytes, hex>"}
```

It answers `{"ok": true, "generation": N, "receipt": "/run/training/slot/preflight.json", "durationMs": …}`.
`recycle` drains (no active turn in the registry and a settled credential
journal), stops the relay, backend and launcher in that order, wipes the slot,
replays the same audited provisioning the entrypoint ran — credential-journal
recovery included, so a crash during a refresh either recovers or fails closed
with a named error — restarts and re-verifies all three identities, runs the
worker-uid denial canaries, and only then publishes
`noopolis.daimon.grok-slot-preflight.v2` with a monotonic `generation` and the
caller's `nonce`. Recycles are serialized; the caller never names a path or a
command. Measured: three recycles at 611–620 ms each.

Nothing the launch mounts may sit inside a directory a recycle removes or
empties: a mount point cannot be unlinked while it is mounted. The broker and
relay therefore take their private `TMPDIR` from `/run/training/broker-tmp`
(`2100:2100 0700`, denied to every worker uid) rather than the production
`<control root>/tmp`, which training clears on every recycle. Provisioning and
recycle skip mount points regardless and name any path they genuinely cannot
clear.

The socket node is `root:2000 0660` inside a root-owned `0711` directory on
tmpfs, which is the uid gate: the kernel enforces it on `connect()` and uid 2200
gets `EACCES`. Node exposes no `SO_PEERCRED`, and a `0600` root-owned socket
would deny the one caller it exists for.

### Credential lineage

```
spawnfile auth import grok --profile paideia-training --from <dir>
        │  refuses ~/.grok and $GROK_HOME outright; --from is required
        ▼
  profile store  ──►  declaration `broker.bootstrap`  ──►  read-only bind
                                                          /var/lib/spawnfile/daimon/grok-bootstrap-auth
                                                                       │
                                            root entrypoint promotes it into the named realm volume
                                                                       ▼
                                          /var/lib/spawnfile/daimon/grok-subscription-realm/auth.json
                                                  (broker uid 2100, rotated in place, journalled)
                                                       │                        │
                                              subject turns              judge/optimizer grants
```

The launch refuses a bootstrap that resolves to the desktop `~/.grok/auth.json`,
both at preparation and again before `docker create`. Judges never hold the
credential: the container exports `PAIDEIA_GROK_BROKER_CONTROL_SOCKET` and a
private `PAIDEIA_GROK_GRANT_HOME_ROOT` (`2000:2000 0700`, denied to every worker
uid) to the `train` child, and each judge lane asks the broker for a bounded
inference grant.

Both ledger directories are setgid to the organization group
(`2100:2000 2750`): the broker writes rows `0640` in its own group, so without
setgid uid 2000 could not read a single usage or inference row it paid for.

### Evaluator roots and deny list

`paideia.daimon-native.launch.v2`'s five evaluator roles carry these real
container paths, and every one of them is a deny entry in the worker's sandbox
profile and a canary in the receipt:

| role | path |
| --- | --- |
| run-root | `/run/training/output` |
| context | `/run/paideia` |
| sealed-inputs | `/run/training/inputs` |
| judge-home | `/run/training/grants` |
| slot-ledger | `/run/training/slot/usage` |

The rest of the deny list is `/etc/daimon-engine-broker`,
`/run/daimon-engine-broker`, `/run/training/inference`,
`/run/training/slot/turns`, `/run/training/supervisor`,
`/var/lib/spawnfile/daimon/{usage,wake-fuse}`, and Daimon's own protected set
(the Grok bootstrap, the realm and `/run/training/slot/state`, the slot state
root that holds the wake-acceptance store). The caller's
`config.json`, `launch.json`, `token`, `env`, `control`, `preparation.json` and
`repair.json` are covered by the single `/run/paideia` mask rather than listed
individually — Grok materializes each deny target inside bubblewrap as the
worker uid and cannot create one inside a directory only uid 2000 may write.

The same rule governs deny *placement* everywhere. A deny entry is placeable
only when it already exists, is not a symlink, and the worker uid can search
every ancestor directory; one unplaceable entry makes Grok refuse the whole
profile, so every turn of that slot fails with `bwrap: Can't create file at …:
Permission denied`, not just that path (matrix:
`.runtime/grok-deny-placement/EVIDENCE.md`). The wake-acceptance store is that
case: its parent `/run/training/slot/state` is `2000:2000 0700`, so the mask
moves onto the state root, which covers it and nothing else. Lifting a mask to a
private ancestor is strictly stronger than masking the leaf and, unlike opening
the ancestor with `o+x`, gives the worker no additional reach. Root provisioning
asserts placement for every entry once all modes are final — at container start
and on every recycle — and refuses the slot otherwise.

A canary is a worker-uid attempt that must fail. What decides whether it means
anything is the **backing filesystem**, not the declaration: a bind on
ext4/xfs/btrfs/overlay enforces unix ownership and is probed for real, while
virtiofs, grpcfuse, 9p, nfs, cifs and fuse ignore `chown` outright — Docker
Desktop and Colima both land every host bind there. Only on those does
`unenforcedBindPolicy` apply: `refuse` (the default) fails the slot and writes
no receipt; `profile-only` accepts the bubblewrap-enforced `deny` list as that
path's only boundary and names every such path in the supervisor log. The
default is therefore reachable: on a Linux daemon over a native filesystem every
deny entry is kernel-probed, and preparation creates the output root `0700`
owned by the invoking user, so uid 2200 is genuinely denied there. On Docker
Desktop and Colima the one entry that forces `profile-only` is
`/run/training/output`, whose inode is the operator's and whose filesystem
ignores `chown`; the sealed datasets never depend on that choice.

Two limits of that are worth stating rather than discovering. A `0700`
host-owned output root also denies uid 2000, so a v3 run on a native
filesystem needs an output directory the in-container organization uid can
write — group `2000` mode `0750`, or an equivalent id mapping — before it can
complete; and under `profile-only` the run root's only boundary is the
bubblewrap `deny` list, which the same namespace route that motivated the
sealed-inputs seal can lift. Sealing the run root the same way means moving the
bind below a baked `0750` ancestor, which changes a container path
`paideia.daimon-native.launch.v2` names, so it is deliberately not done here.

### The sealed datasets

`/run/training/inputs` is not covered by that policy at all, and no declaration
can waive it. It holds the sealed train and test datasets, and the bubblewrap
`deny` list is not a boundary the subject cannot lift: the pinned seccomp
profile has to allow `clone/clone3/unshare/mount/umount2/pivot_root/setns` for
bubblewrap itself, and the container runs `apparmor=unconfined`, so a worker-uid
process can open a user and mount namespace of its own and either detach the
mask or bind the mask's parent somewhere fresh. Evidence gathered with `cat` and
`read_file` says nothing about that route.

What holds against it is DAC on the datasets' ancestor. Every declared input is
bound at `/run/training/inputs/<id>` — the launch schema admits no other
destination — so `/run/training/inputs` itself is their parent, a directory on
the read-only image root. The image bakes it `0:2000 0750`:

- uid 2200 is in neither the owner nor the group class, so it loses *search*
  permission on the one directory every dataset read must traverse;
- the inode is owned by real uid 0, which `unshare --map-root-user` does not
  map, so `CAP_DAC_OVERRIDE` inside the worker's own namespace cannot override
  it, and a fresh `mount --bind` of the parent re-exposes this same directory
  rather than the bytes beneath it;
- the root filesystem is read-only, so nothing in the container — root included
  — can widen the mode after the image is built.

Root provisioning therefore asserts that identity instead of setting it, and
refuses the slot when an image did not bake it. It then attacks the seal as the
worker uid, at container start and on every recycle, from the worker's **own
private tmp** — never `/tmp`, which the broker provisioning closes to
`root:2000 1774` so a worker lists names only, and probing from there refused
the first live run on a `mkdir` rather than on the seal. The routes are a direct
read/search/list; the same list after `unshare --user --map-root-user --mount`
plus a lazy unmount of the mask and its parent; the same list through a fresh
`mount --bind` of `/run/training` inside that namespace; and, per dataset, a
read and a `mount --bind` of the dataset's *own* mount, the route that carries
no mask and is not refused for locked children the way binding its parent is. A
control container left at Docker's own `0755 root:root` hands the held-out
answer key to uid 2200 through three of those; the sealed one refuses all of
them (`.runtime/sealed-inputs-dac/EVIDENCE.md`).

Each route yields exactly one verdict, and they are deliberately not
interchangeable:

| verdict | meaning |
| --- | --- |
| `reachable` | the bytes were read — refuse the slot |
| `denied at-read` | the route ran and the kernel's permission check refused the open or list; the DAC seal did the work |
| `denied at-mount` | the mount the route needs was refused although the syscall is available |
| `unavailable seccomp` / `unavailable kernel` | the worker uid cannot open the namespace the route needs, so the route provably cannot happen — a *stronger* denial than DAC, with the layer that refused it named |
| anything else | no verdict — refuse the slot, and print the probe's stderr |

"Provably cannot happen" and "could not tell" never collapse into one pass. The
mechanism behind an unavailable namespace is derived, not guessed: a seccomp
`EPERM` and a kernel or LSM `EPERM` are indistinguishable by errno, so
Spawnfile answers it from the pinned profile it ships and the declaration's
digest binds — `seccomp` when that profile does not allow `unshare`, `mount`,
`umount2` and `setns` unconditionally, `kernel` when it does and the syscall was
still refused. The pinned `seccomp-default-plus-userns` profile allows all four
outright, because bubblewrap needs them, so in production an unavailable
namespace is reported as `kernel`.

Provisioning records every route and its verdict in
`/run/training/slot/sealed-inputs.json`, a Spawnfile-owned
`spawnfile.training-sealed-inputs.v1` attestation, `root:2000 0640` beside the
slot preflight receipt. It is separate on purpose: the canary members of
`noopolis.daimon.grok-slot-preflight.v2` are a cross-repo contract whose schema
lives in Daimon, and a bare `result: "denied"` there must not be read as "DAC
held" when a filtered syscall is what refused the route.

The slot canary for this path additionally requires the worker uid to be unable
to *enter* the directory, not merely to read it: a searchable directory hands
over every dataset the subject can name.

### Evidence before the first trial

`provision → start → canaries → generation → receipt` is the whole start-up
path, in that order, and it is the only way this container brings a slot up.
Start-up used to stop after `start()`, with the canaries and the
`noopolis.daimon.grok-slot-preflight.v2` receipt reachable only through
`recycle`, so the first trial of every run — the one trial whose sealed
datasets had never been probed — executed on no worker-uid denial evidence at
all, and a refusal surfaced only after that trial's spend. The start-up receipt
carries the container's own nonce and generation 1..N, in the same shape a
recycle publishes and from the same canaries.
