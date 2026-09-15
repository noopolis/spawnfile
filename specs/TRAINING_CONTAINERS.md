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
| grok | `.grok/auth.json` |
| claude | `.claude/.credentials.json` |

The image startup can stage Grok/Claude into its clean shared home. A native trial
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
      "grok": { "source": "./bin/grok", "sha256": "sha256:<64 hex characters>" },
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
