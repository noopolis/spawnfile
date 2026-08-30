# Target Resource Boundary

Status: evolving

`src/target` defines the project-neutral public target-resource contracts. The
six v1 identities are `spawnfile.target-resource.request.v1`,
`spawnfile.target-resource.receipt.v1`,
`spawnfile.target-resource.selected-target.v1`,
`spawnfile.target-resource.journal.v1`,
`spawnfile.target-resource.operation-lookup.v1`, and
`spawnfile.target-resource.export-index.v1`.

The separate read-only topology pair is
`spawnfile.target-topology-attestation.request.v1` and
`spawnfile.target-topology-receipt.v1`. It never creates a journal operation:
the request only correlates completed opaque operation/result handles, and the
target owner proves every fact from private records and exact Docker
projections. It opens an already-existing journal identity read-only; unknown
correlations never create target state.

The separate read-only world-readiness pair is
`spawnfile.target-world-readiness.request.v1` and
`spawnfile.target-world-readiness-receipt.v1`. The request binds one exact
recorded world service and fixed `/v1/world/readiness` path to expected public
world identities. The receipt carries only the verified paused/pristine
document plus canonical request and document digests; it is not a lifecycle
receipt or target-resource mutation.

That endpoint is the pre-activation surface of the base
`simfile.world-sidecar-runtime.v1` ABI. The separate read-only
`spawnfile.target-world-clock.request.v1` and
`spawnfile.target-world-clock-receipt.v1` pair binds the same recorded service
to fixed `/v1/world/clock` only after activation. Optional capability
identities such as `simfile.world-decision-claim.v1` are separately manifested:
Spawnfile correlates their exact identity and digest when requested but never
implements a claim, interprets its payload, grants decision authority, or uses
it as lifecycle/readiness authority.

`activate_topology` is the separate owner-controlled lifecycle release after
that proof. It accepts the unchanged topology-attestation request, repeats the
exact proof under the same lifecycle lease, and only then publishes
`spawnfile.world-service-activation.v1` into the world service's existing
evidence mount. The canonical marker binds the run, immutable world-artifact
manifest digest, topology request digest, and topology receipt digest. It is
not provider traffic, an agent tool, a network endpoint, or a selectable
target-resource mutation.

All public inputs and outputs are strict JSON-shaped objects. They use bounded
run identifiers, canonical digests, identifier-safe labels, and opaque handles.
`parseOpaqueTargetHandle` is the single public authority for opaque-handle
grammar; later target packets must consume it rather than define a namespace.
The selected-target receipt intentionally contains only its opaque handle and
endpoint fingerprint: it does not expose selector authority.
Except for the fixed world-readiness path, its declared container-internal port,
and its bounded provider-neutral public readiness document, they must not
contain secret values, Docker endpoints, contexts, argv, resource IDs, paths,
URLs, ports, identities, provider payloads, runtime payloads, raw errors,
topology details, or scenario fields. The journal contract is a
secret-free shape only; a later adapter may keep private resource mappings, but
must never serialize such a map through this boundary.

`attest_topology` writes one canonical topology receipt. It contains only safe
correlation plus semantic facts: an internal private data network, an exactly
attached organization with one proven non-internal egress network, and one
running world service with one private network attachment, no egress or
published ports, and DNS-only discovery. The owner obtains the organization's
other network name from an exact bounded container projection, directly inspects
that one network to prove `Internal:false`, then discards the name. No names,
IDs, endpoints, contexts, URLs, paths, raw inspections, port values, or secrets
are returned. The owner resolves the named Docker context once, snapshots its
private transport/TLS material into a short-lived private Docker config, binds
every inspection to that synthetic context, and compares the observed
data-network ID at every organization/world anchor with the journaled immutable
ID. A journal-scoped lifecycle lease spans each owner mutation and this
attestation, so supported teardown cannot race the proof.

## Target CLI

### Capability discovery

An automation client must query capabilities before using a versioned public
contract:

```bash
spawnfile capabilities --json
```

This command is read-only: it reads only the packaged Spawnfile version, does
not consume standard input, does not write files, and does not contact Docker
or any provider. Success emits exactly one strict
`spawnfile.capabilities.v1` JSON document followed by a newline. Missing
`--json` fails with exit code 2 and emits no receipt.

The receipt names the exact target-config resolver command and output/config
versions. It also carries the complete closed
`spawnfile.composed-lifecycle-contract-set.v1` command-and-contract inventory:
an automation client MUST require `complete: true`, the exact set version, and
every command row it intends to use before mutation. Each row has a canonical
`argv` form plus explicit `stdin_versions`, `request_versions`,
`receipt_versions`, `invocation_versions`, and `pending_versions`; empty lists
mean that role is intentionally unversioned or unused. Image-reference `up` is
not in that inventory: only project-mode `up --json` with a lifecycle
invocation has correlated, lookup-recoverable machine semantics. It also names
the self-identifying prepared-plan version. That v1 plan accepts exactly
`version`, `evidence_destination`, plus one `prepared_artifact_mapping`;
unknown keys are rejected. The credential
provisioning request supports an optional `model_engine_auth` member, so a
scripted organization need not provide model-engine auth.

The receipt reports only shipped public capabilities. The current build ships
the Spawnfile-owned, target-local
`spawnfile.target-evidence-export-helper.prepared.v1` helper receipt. It is
prepared with `spawnfile helper prepare-evidence-export --context <name> --json`
and selected by `target resolve_config --prepare-evidence-helper`; callers do
not provide an authority-file path. Its identity is the exact Docker image
config digest, so a classic local Docker engine need not expose a registry
manifest digest. Its
public-artifact snapshot query returns the typed
`spawnfile.target-public-artifact-snapshot.not-present.v1` result when the
declared terminal artifact does not yet exist. It reads that terminal artifact
with one atomic no-follow open from a dedicated public tmpfs mount; a symlink,
parent traversal, replacement failure, or any other read failure is permanent
and MUST NOT be translated to `not_present`. Capability discovery does not
prove that a target or auth preflight will succeed on every machine. A caller
must validate the exact receipt versions it requires before beginning mutations.

### Local evidence-export helper

Spawnfile owns the local-development helper source, canonical USTAR build
context, image construction, and private transaction authority. Provision it
only on an explicitly named local Docker context whose selected Node base image
is already present:

```bash
spawnfile helper prepare-evidence-export \
  --context default \
  --json
```

The command accepts `--base-image`, `--docker-command`, and a bounded
`--timeout-ms` when their defaults are unsuitable. It never selects the
current context implicitly, never targets a remote endpoint, never pulls or
pushes, and runs the Docker build with networking disabled. The package-shipped
recipe creates the exact helper label, `/bin/spawnfile-export-helper`
entrypoint, `65534:65534` user, and exactly one nonsecret environment entry:
`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. Null,
duplicate, additional, or drifted image environment entries are rejected. The
helper emits the strict canonical USTAR output required by the evidence-export
contract.

Before the first Docker mutation Spawnfile persists and fsyncs one deterministic
pending transaction under its private target-local state root. That record binds
the exact context endpoint, daemon projection, platform, base config digest,
recipe digest, and a private reservation. The build captures Docker's emitted
immutable config ID directly rather than adopting a mutable tag. Recovery only
re-attests that completed exact config ID or rebuilds it from the same packaged
recipe; a pending-only reservation never consults or overwrites a helper tag.
It never discovers resources by listing or name scan. A public result is only the canonical
`spawnfile.target-evidence-export-helper.prepared.v1` receipt with its opaque
handle and digest. The Docker image identity used by target lowering is the
locally accepted config digest; a registry or `RepoDigest` is not required.

The resolver may prepare the same package-owned artifact as part of its target
setup path:

```bash
spawnfile target resolve_config \
  --context default \
  --evidence-destination "$PWD/.spawn-local/evidence.tar" \
  --prepare-evidence-helper
```

The resolver and target lifecycle consume the opaque preparation internally;
no caller-managed authority-file path is accepted.

The `target resolve_config` result contains `target_config_digest`, computed
over canonical JSON bytes of its strict `target_config` under
`spawnfile.target-config-digest.v1`. When and only when
`--prepare-evidence-helper` was requested on an explicitly selected local
context, it also contains `prepared_evidence_helper`; that opaque receipt is
the exact same value embedded as `target_config.preparedEvidenceHelper`.
No helper config identity, daemon projection, reservation detail, or authority
path is public.

The built Spawnfile CLI exposes fourteen mutating/selection verbs, four
read-only target queries, one owner-only lifecycle release, one separate
read-only journal lookup, and one aggregate preparation command:

- `select_target`
- `resolve_world_artifact`
- `prepare_secret_bindings`
- `create_data_network`
- `create_evidence_volume`
- `attach_organization`
- `create_world_service`
- `start_world_service`
- `stop_world_service`
- `export_evidence_volume`
- `recover_operation`
- `revoke_secret_bindings`
- `detach_organization`
- `cleanup_run`
- `attest_topology`
- `snapshot_public_artifact`
- `query_world_readiness`
- `query_world_clock`
- `activate_topology`
- `lookup_operation`
- `prepare_composed_run`

A composed-lifecycle consumer uses one aggregate preparation command rather
than choosing among the low-level preparation verbs:

```bash
target-config-producer gpu-host \
  | spawnfile target --config - prepare_composed_run /absolute/path/request.json
```

`spawnfile.composed-preparation.request.v1` binds the run, descriptor,
nonsecret target selector and auth-profile name, immutable organization/world
digests, opaque target-secret source handles, and one idempotency key. Spawnfile
derives fixed per-operation keys and executes only `select_target`,
`resolve_world_artifact`, `prepare_secret_bindings`, `create_data_network`, and
`create_evidence_volume`, in that order. It starts neither the world nor the
organization. Exact retry emits the same canonical
`spawnfile.composed-preparation.receipt.v1`, containing only the selected
target and correlated opaque receipts. Private target configuration and secret
values remain stdin/provider authority and cannot enter either contract.

Every invocation has this form, with an absolute request-file path:

```bash
target-config-producer | spawnfile target --config - <verb> /absolute/path/request.json
```

`--config -` is literal: the CLI accepts only one strict private target
configuration object from standard input. It does not accept a configuration
path, inline JSON, environment-derived secret values, or request-relative file
paths. Request validation happens before configuration is read or a target
operation starts.

### Composed-lifecycle client inputs

There is no product-specific operator-input request. A composed-lifecycle client
discovers the machine-readable command set with `spawnfile capabilities --json`
and uses only rows advertised by `spawnfile.composed-lifecycle-contract-set.v1`.
It owns its local run-root layout, local authentication policy, and any
runtime-specific asset selection.

The public CLI carries only versioned public requests and receipts. Target
configuration remains the strict private stdin input accepted exclusively by
`--config -`; it is never copied into a request or receipt. A client that needs
a resolved target uses the advertised `target resolve_config` contract, whose
`spawnfile.target-config-resolution.v1` receipt binds the strict target-config
digest, context class, platform, and base-image identity. Lifecycle calls bind
their idempotency and recovery through their published invocation and receipt
versions. These generic contracts do not grant an external caller access to
private target configuration or local credential values.

The optional `container_bundle_store_root` member selects a dedicated,
mode-`0700`, current-uid-owned physical directory for immutable target-local
container-bundle mappings and archives. It must be an absolute normalized
non-root path, cannot be a symlink or overlap the per-run target lifecycle root,
and is the only target authority allowed to outlive a fresh `SPAWNFILE_HOME`.
Journals, artifact identities, secret, attachment, world, and evidence
authorities remain under that per-run home. Omitting the member preserves the
original `$SPAWNFILE_HOME/target/container-bundles` default. A durable mapping
is still re-attested against the exact selected daemon, image config, labels,
and platform before use; an orphan image tag without its private mapping is
ambiguous and is never adopted.

`lookup_operation` is a separate read-only command, not a selectable target
operation. It accepts the unchanged original mutation request and a minimal
`spawnfile.target-lookup-config.v1` context document:

```bash
printf '%s' '{"context":"gpu_host","version":"spawnfile.target-lookup-config.v1"}' \
  | spawnfile target --config - lookup_operation /absolute/path/original-request.json
```

It opens only the exact existing journal and emits one canonical `completed`,
`pending`, or `not_applied` result. It never initializes target configuration,
creates or locks a journal, calls a provider, or accepts `select_target`;
repeated reads are safe.

On success, `select_target` writes one canonical selected-target receipt and
every mutation writes one canonical target-resource receipt, each followed by
one newline; the exit status is `0` and stderr is empty. An invalid request or
configuration writes no receipt, returns `2`, and emits only the corresponding
generic diagnostic. An operation failure writes no receipt, returns `1`, and
emits only `error: Target operation failed`. Receipts and diagnostics never
contain secret values or private provider details.

## Contract and implementation status

The sections below retain their T1–T10 labels as design provenance. The
reference implementation now includes the strict stores and journals, target
selection, Docker execution, secret materialization, organization attachment,
world-service lifecycle/readiness/activation, evidence export, cleanup, and
recovery described here. None of those implementation ports broadens the
public target contracts or gives Spawnfile simulation, provider-traffic, or
agent-cognition authority.

## Immutable artifact identity (T5)

`resolve_world_artifact` writes one canonical private identity record for its
exact operation-handle/request-digest pair. Its store root must be a real
mode-`0700` directory owned by the running Spawnfile uid; records and the one
deterministic pending name are mode `0600`, owner-checked regular files. A
binding or recovery fails closed on a symlink, non-owner, insecure mode,
hardlink outside the final/pending pair, malformed bytes, or a conflicting
final/pending record. Independent store instances may race to publish the same
bytes: either may link the final and either may remove the pending name, but
both must re-read and prove the exact one-link final before success. Different
bytes for that pair never overwrite or join.

This is a same-uid trusted local-state boundary, not a defense against a
malicious process already running as that uid inside the checked root. Such a
process can rewrite Spawnfile state and code; arbitrary concurrent pathname
replacement by that principal is outside this adapter's threat model. The
record is private and never enters the public journal or receipt.

## Trusted-operator secret backend (T6)

`prepare_secret_bindings` carries only bounded binding names, scopes, and opaque
source handles. A private trusted-operator resolver authorizes each resolution
for the exact run, descriptor, selected target, journal claim, request, scope,
and name and returns a separate opaque immutable source-version handle. Before
Docker mutation, mode-`0600` target-local authority records bind both the claim
and each source capability to that exact authorization and version handle; a
reconstructed retry or cross-run/target/scope rebinding fails before another
stdin write. The private records contain no value or
value-derived digest and never enter a receipt, journal, label, or artifact.
The resolver transfers owned byte arrays to the adapter; the adapter clears
those arrays and its in-memory archive after use. Values are never accepted
from request fields or process environment variables.

The Docker lowering creates one deterministically named, exactly labeled volume
and invokes the fixed writer runtime
`docker.io/library/busybox@sha256:222ad6d973c0d198014546a65cd02c5fdedcc172123c5b4c2bf0af636550bd94`.
The adapter-owned writer command receives a bounded USTAR archive through stdin
only. Its argv, environment, labels, output, receipts, journal, and temporary
filesystem contain no secret values; the container has no network, no log
driver, a read-only root filesystem, dropped capabilities, bounded resources,
fixed non-secret environment, private namespaces, no restart/publish/device or
host authority, and one writable volume mount. Exact inspection of that full
security projection is required before a pending writer may be waited on,
removed, or adopted. Secret files are installed mode `0444` beneath
mode-`0755` scope directories so arbitrary non-root runtime UIDs can read an
explicitly mounted scope. Isolation comes from mounting only the granted volume
or subpath; later consumers must always mount it read-only.

The operation journal is reserved before mutation. Exact live requests join;
pending retries validate only the deterministic volume and writer names plus
their complete labels/configuration. A retry either waits for the exact active
writer or rewrites the complete archive, so partial writes never become a
receipt. `revoke_secret_bindings` force-removes only that exact writer, then the
exact volume; already-absent resources are successful crash recovery. Neither
operation lists or scans Docker resources.

This protects values from normal Spawnfile artifacts and diagnostics, not from
the Docker security boundary itself. A daemon administrator or host root can
inspect volumes, memory, or traffic and is therefore trusted. The resolver and
executor are private injection seams for tests and target wiring, not public
provider-neutral API, and implementations must not log, retain, or reflect
stdin bytes or resolver errors.

## Auth-owned target-secret private store contract

`auth` owns the host-local private store at `$SPAWNFILE_HOME/auth/target-secrets`.

- Trusted model: same-uid and same-host-root only.
- Fixed, direct-keyed layout is required: `versions`, `grants`, `redemptions`,
  `revocations`, and `aliases`.
- Store layout and records are plaintext-only, with owner-checked mode `0700`
  roots and mode `0600` regular files.
- Same-uid compromise, forensic erasure, and encryption without external key
  authority are out of scope.
- No secret values may be written to env vars, argv, request payloads, temporary
  files, logs, or public artifacts.
- Versions are immutable; grants are one-claim records; rotation and revocation
  are handled through explicit fixed-directory records.

## Opaque organization attachment (T7)

`attach_organization` accepts only the public opaque handoff and data-network
handles. A private trusted resolver binds the handoff handle to the exact
`spawnfile.organization-handoff.v1`, its descriptor-to-binding digest,
selected-target receipt and supplied receipt digest, and the provider-owned
network-attachment handle. That last private capability resolves to one full
container ID and the six expected Spawnfile deployment labels. The handoff's
derived deployment handle is correlation only; it is never Docker authority.
No new selected-target digest algorithm is invented here: the resolver's exact
receipt/digest association must match both the request target and the digest
already carried by the handoff.

Before mutation, mode-`0600` immutable records under a mode-`0700` root bind the
request claim to the full resolution and the resulting attachment handle back
to the exact network ID, container ID, and labels. A changed cross-process
resolution fails before Docker. Detach loads that stored binding and never
re-resolves current organization identity.

The Docker lowering reconstructs the prior T4 internal-network name and labels
from its completed journal claim, then inspects only that exact network and the
resolved full container ID. It mutates only `network connect <network-id>
<container-id>` or `network disconnect <network-id> <container-id>` and verifies
the exact edge afterward. Fresh attach requires the edge to be absent; fresh
detach requires it to be present. Only an exact pending journal operation may
adopt the corresponding post-crash state after loading an immutable mutation
admission written only after its fresh pre-state passed inspection. A rejected
fresh pre-state can therefore never become recovery authority on retry. No list,
scan, container discovery, raw ID in a public receipt, readiness claim, or
provider traffic is permitted.

## World-service lifecycle (T8)

`create_world_service` joins four previously completed opaque capabilities: an
immutable world artifact, the internal data network, the evidence volume, and
the scoped secret volume. A trusted private resolver returns only the exact
artifact identity associated with the supplied artifact handle. Spawnfile
reconstructs the two resource identities from their completed journal claims,
reconstructs the secret volume from its opaque binding handle, and revalidates
the selected Docker context before touching the daemon.

The Docker lowering creates one deterministic sidecar from the immutable image
digest. It has exactly one internal network attachment, no published or exposed
ports, a read-only root filesystem, no log driver, no restart policy, no added
capabilities, devices, binds, DNS, links, groups, or host namespace authority.
It mounts only the exact evidence volume read-write and exact scoped-secret
volume read-only. Exact inspection revalidates the complete bounded projection
before any service is adopted, started, stopped, or removed.

Create, start, and stop reserve the target journal before mutation. Immutable
mode-`0600` private records bind artifact resolution, the resulting opaque
service handle to its full container identity, and each allowed mutation to its
claim. Fresh operations first prove the required pre-state and only then write
mutation admission; pending retries must load that exact admission before any
inspection or mutation. This prevents an unrelated pre-existing container from
becoming recovery authority. Create may recover one exact admitted container,
start may recover the exact running state, and stop may recover the exact
removed state; missing admission or configuration drift fails closed.

T8 reports lifecycle only. It does not own health or readiness, application
logs, endpoints, world identity, agent behavior, social traffic, simulation
state, or evidence export. It never lists, scans, guesses, or exposes Docker
names, IDs, context endpoints, argv, mount paths, or private resolution data in
public receipts.

### World-only readiness query

`query_world_readiness` is separate from T8 lifecycle mutation. Its strict
request names only one opaque recorded world-service handle, exact run,
descriptor and selected-target correlation, the fixed readiness path, one
container-internal port, and expected public document identities. A private
adapter loads that exact world binding, proves the container is running, and
executes a fixed bounded HTTP GET to `127.0.0.1` inside that same container. It
does not publish or discover a port and cannot address any organization, team,
participant, provider transport, room, or transcript surface.

The response must be a strict versioned readiness document for the exact run,
world instance, artifact, bundle and sorted capability-manifest digests. It must
report `clock:{state:"paused",next_tick:0}` and
`decisions:{phase:"open",count:0}`. Spawnfile reinspects the exact container
after the read and emits a canonical
`spawnfile.target-world-readiness-receipt.v1` with request and document digests.
Forged, stale, non-pristine, oversized, non-JSON, or identity-drifted documents
fail closed. This query neither changes nor extends the world sidecar ABI.

### Post-activation first-tick query

`query_world_clock` is separate from readiness and lifecycle mutation. Its
strict request binds the exact recorded service to the activation digest and
receipt plus both topology request/receipt digests, and fixes the endpoint to
`/v1/world/clock`. The returned clock must be running with
`next_tick = completed_tick + 1` and at least tick 1 completed. The bootstrap
observation must report `action_count: 0`: it proves the first tick followed
activation without depending on a participant action or reply. Cross-run,
pre-activation, stale-topology, zero-tick, action-bearing, oversized, or
identity-drifted observations fail closed.

## Evidence-volume export (T9)

`export_evidence_volume` reconstructs the exact completed evidence-volume claim
from the current target journal, then inspects only that deterministic volume and
its complete labels on the selected context. Its helper bundle supplies only an
exact `operation_handle`, `request_digest`, and result-handle lookup into the
existing private world-artifact identity authority; the matching completed
`resolve_world_artifact` journal claim, selected target, deterministic result,
and configured helper manifest must all agree. No caller-supplied helper record
is trusted, and the resolved immutable OCI identity never enters a request,
receipt, or index. The helper is created,
strictly inspected, attached, and removed with a read-only evidence mount and no
network, ports, privilege, capabilities, devices, binds, host namespaces,
logging, restart, or egress. The operator destination is a private argument: it
is never journaled, indexed, or returned, and publication uses a same-directory
no-clobber atomic link after a synced temporary file.

The helper output is untrusted. Spawnfile accepts only bounded USTAR snapshots
containing ordinary UTF-8 regular files and directories; links, devices, FIFOs,
extensions, unsafe/duplicate paths, malformed headers, and trailing garbage are
rejected. It counts those entries itself and re-emits fixed metadata in sorted
path order before digesting. Snapshot contents remain opaque: this boundary does
not interpret, seal, or attest their application-level evidence meaning.

The public receipt remains the regular target receipt. A target-local mode-0600
immutable authority store, keyed by the exact journal operation handle, records
only the reconstructed resource identity/admission, a root-local HMAC commitment
to the operator destination (never its path or basename), and canonical secret-free
`spawnfile.target-resource.export-index.v1` bytes. It cannot create or repair a
journal fact. Destination replay must match that commitment before helper mutation.
The production command admits its configured helper as the immediately preceding
journal mutation, so a normal export request's `expected_revision` is one greater
than the current revision. That helper request is derived deterministically from
the export request and private configuration; explicit recovery reuses the
completed admission and does not resolve the helper again.
The index is bound before publication; an explicit recovery path may regenerate
the bytes and verify its digest/count before accepting an already-published
regular file or publishing it without clobbering. A missing admission, label
drift, malformed helper output, or ambiguous partial publication fails closed.
The same private root has one short-lived, token-bound export-owner claim for an
exact admission. It is only single-operation exclusion, not a journal or
provider-quiescence protocol: after journal reservation, every normal pending
caller returns an internal incomplete result immediately, without Docker,
destination, index, or journal-completion mutation. Only an explicit recovery
path may clear a proven-dead exact claim and resume later; it returns before a
later atomic claim elects the next owner. Claim and HMAC-key publication use
synced temporary-to-pending-to-final links so either crash point is recoverable.
Before clearing either a final or pending-only claim, recovery hard-links its
observed inode to one deterministic recovery tombstone. It re-reads the token,
inode, and owner through both names before unlinking; a delayed recovery that
pins a newer claim removes only its tombstone. A tombstone makes normal election
incomplete and is rechecked before pending/final publication. A releasing owner
uses the same exact-inode pin and bounded rereads while another pin exists, so
it neither deletes that pin nor releases a replacement generation.
Spawnfile owns copying and lifecycle only; evidence semantics and sealing remain
upstream.

An incomplete evidence export is never a successful export and never licenses
ordinary cleanup to erase its evidence volume. Only an explicit
`recover_operation` for the exact journaled request/admission may resume
publication. Operators must preserve the emitted journal/recovery authority
and evidence resource until recovery completes; if exact recovery cannot
complete, cleanup remains incomplete and fails closed rather than starting a
new export or silently discarding evidence.
