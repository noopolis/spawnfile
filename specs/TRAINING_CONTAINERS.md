# Training in one container

`spawnfile train` runs the complete model-bearing experiment in one immutable
Docker image: Paideia, DSPy, the integration, Daimon and inference CLIs. The host
validates declarations, mounts explicit inputs, forwards output and supervises
container termination. No Docker socket enters the container. Dry-run remains a
host-only estimate and does not use Docker or model authentication.

## Launch contract

Actual training requires both `--training-image` (a digest reference or immutable
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
