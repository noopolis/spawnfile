# Training image

Owns the single-container training dependency recipe. Spawnfile launches and
stops the outer container; Paideia supervises experiments and native trial child
processes inside it. No Docker socket or host home is mounted.

Build inputs are explicit package distributions, locked dependency manifests,
verified native executables and an installed integration entrypoint. Credentials,
cases and results are runtime mounts, never image contents. Native runtime and
Python base images must be immutable. Do not download unpinned CLI installers.
The recipe is opt-in during incubation; no published runtime is implied.

## Layer order and modes

Layers run from least to most frequently changing: Python parent copies,
Bookworm's pinned `libfaketime=0.9.10-2.1`, the baked `2000`/`2100`/`2200` Daimon identities,
locked Claude/Paideia/Spawnfile/compiler dependencies, the lock-keyed DSPy venv,
one layout RUN, bridge source plus its editable install, then the entrypoints and
distributions. Nothing RUNs after the late COPY layers, so a changed distribution
rebuilds its own COPY layer, every later COPY layer and the label, but no RUN
layer (no npm, pip or recursive chmod work).

Both parents must use Debian Bookworm. The early package layer resolves the
multiarch distro library with `dpkg-query` and creates the root-owned fixed
symlink `/usr/local/lib/daimon/libfaketime.so.1`. Never set image-wide
`LD_PRELOAD`: brokered Grok supplies it only through the clocked shell policy;
direct Daimon tool children receive it from the trial caller. The mode verifier
includes the symlink and resolved distro file on both architectures.

The image copies no Grok binary: `spawnfile.training-container.v3` runs the
native parent's pinned `/usr/local/bin/grok` through the broker, and a second
copy could only ever be an unattested build. The fixed uid/gid identities are
baked because that container's root filesystem is read-only, so its entrypoint
cannot write `/etc/passwd` the way the production organization entrypoint does.

In-image modes are unchanged from the former `chmod 0555 train train-broker &&
chmod -R a+rX /opt/training`, and owners stay COPY/RUN defaults (root):

- Staged context (`src/compiler/training/preparation/contextModes.ts`): every
  directory gains 0555 (private staging dirs become 0755); every file gains 0444
  plus 0111 when any execute bit exists (0600 -> 0644, 0700/0744 -> 0755,
  0400 -> 0444); `train` and `train-broker` are exactly 0555. Staged mtimes are
  fixed at 2000-01-01T00:00:00Z.
- RUN outputs: a `find ... -exec chmod a+rX` closure that selects only entries the
  recursive chmod would change, so closed lower-layer files are never copied up.
  It covers `/opt/training` after dependencies and the bridge after `pip -e`. The
  integration `node_modules` layout is created after the closure, as before.
- `contextModes.test.ts` runs the rendered closure against real `chmod -R a+rX`
  and asserts staged modes, recipe order and symlinks. Build-cache and timing
  effects require a Docker-enabled measurement
  (`npm run verify:training-image-modes`, evidence in `.runtime/grok-p5/build/`).

## Broker contract paths

The layout RUN also installs the native parent's own pinned Grok and engine
broker at `/usr/local/bin/grok` and `/opt/daimon/bin/daimon-engine-broker`, the
two paths `GROK_ENGINE_BROKER` fixes, exactly as a generated organization image
does (`src/runtime/container.ts`). It introduces no second build — both come
from `/opt/spawnfile/runtime-installs/daimon/bin` — and a parent whose Grok is
not a manifest-pinned 1.0.34 build is refused at slot provisioning and again by
the slot supervisor, by digest. `spawnfile/node_modules/@noopolis/daimon` links
to the same install so the root entrypoint can import Daimon's public
`/runtime` export for the broker projection.
