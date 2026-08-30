# Target Contract Guide

`src/target/` owns the project-neutral target-resource boundary.

- `contracts.ts` contains only strict, secret-free public contract parsers and types.
- `composedPreparation.ts` owns the one high-level, provider-neutral preparation request/receipt and lowers it into the fixed idempotent artifact, secret, network, and evidence-volume sequence. It starts no services or organization.
- `cleanupRun.ts` is the public provider-neutral cleanup orchestrator. It accepts
  only opaque resources resolved from the exact journaled request and delegates
  provider effects through injected steps in fixed world, attachment, secret,
  evidence, and network order. Recovery and cleanup must use exact recorded
  handles and private authority; discovery, listing, name scans, and ownership
  inference are forbidden.
- Public evidence and recovery are contract surfaces, not provider operations.
  `export_evidence_volume`, `recover_operation`, and the export-index schema are
  exported through `contracts.ts`; the journal exposes exact completed-receipt
  recovery. An incomplete evidence export remains incomplete: cleanup may
  preserve its exact evidence resource, but removal must not claim that export
  completed.
- `lookup_operation` is a read-only public journal query, not a target-resource
  operation. It accepts the exact original mutation request, matches its
  idempotency key and canonical request digest, and returns only canonical
  `completed`, `pending`, or `not_applied` state. It must not select a target,
  initialize state, acquire a mutation lock, or call a provider.
- `snapshot_public_artifact` is a read-only public projection query, not a
  mutation or an evidence export. Its public contract declares one bounded
  direct child of `/tmp/spawnfile-public/` and returns only canonical bytes plus
  public correlation digests. The world service provides that root as a
  separately attested tmpfs mount, and one atomic `O_NOFOLLOW` open reads its
  terminal child without a check-then-read race. Only the reader's exact empty
  terminal-absence exit returns the strict versioned `not_present` result;
  every link, replacement, request, authority, container, path-safety, or
  provider failure remains permanent. The private provider resolves one exact recorded
  world-service handle and may copy only that declared path; it never lists,
  searches, reads logs, reads evidence volumes, publishes a port, or exposes a
  provider identity.
- `query_world_readiness` is a read-only public world-only query, not a
  lifecycle mutation. Its provider-neutral request pins one opaque recorded
  world-service handle, the fixed readiness path, and exact expected public
  document identities. The private Docker adapter may query only loopback in
  that exact running container, bounds the response, reinspects the container,
  and returns a canonical correlated receipt. It has no organization, team, or
  transport authority.
- `query_world_clock` is a read-only post-activation query. It binds one
  recorded world service to exact activation/topology digests and accepts only
  observed zero-action progress at or beyond the first completed tick.
- `cleanupRunDocker*.ts` is the private Docker preparation and step adapter for
  `cleanupRun.ts`. It resolves only exact private records and is not
  barrel-exported.
- `dockerResources*.ts` is a private Docker lowering seam; it is not exported by
  this provider-neutral boundary and must not expose provider identifiers.
- `dockerArtifacts*.ts` is a private immutable-OCI resolution and Docker
  lowering seam; it is not exported by this provider-neutral boundary. Its
  private identity contracts live in `dockerArtifactIdentityTypes.ts`. Its
  exact identity store is a mode-0700 root owned by the running uid with
  mode-0600 records and one deterministic pending name. It rejects malformed,
  linked, wrong-owner, wrong-mode, or symlinked state at operation boundaries;
  malicious concurrent mutation by that same uid inside its trusted root is out
  of scope because that principal already owns Spawnfile state and code.
- `dockerSecrets*.ts` is the private trusted-operator secret lowering. Secret
  values may cross only its in-memory resolver-to-writer stdin path; its private
  authority store persists opaque source versions, never values or value
  digests. Neither the module nor provider details are exported from `index.ts`.
- `organizationAttachment*.ts` is the private handoff-to-Docker edge lowering.
  It binds a reviewed organization handoff to one exact container/network pair,
  persists private immutable resolution, binding, and mutation-admission
  authority records, and is not barrel-exported.
- `dockerWorldService*.ts` is the private world-sidecar lifecycle lowering. It
  joins reviewed artifact, network, volume, secret, and target authority; owns
  only exact create/start/stop/inspect/remove behavior; and is not
  barrel-exported. It must not claim readiness, logs, URLs, world identity,
  simulation behavior, or provider discovery.
- `dockerProjectionJson.ts` is the private duplicate-key-rejecting JSON parser
  shared by exact Docker inspection projections; it has no provider discovery
  or public-contract authority.
- `dockerWorldReadiness.ts` is the separate private read-only lowering for the
  public readiness contract. It is not barrel-exported and must depend only on
  exact world-service authority and bounded public-command execution.
- `evidenceExport*.ts` is the private, operator-destination export lowering. It
  keeps publication fault-injection contracts in `evidenceExportPublicationTypes.ts`.
  It reconstructs one recorded evidence volume, inspects a bound helper image and
  helper container exactly, and records an immutable secret-free export index for
  replay semantics. It never exports
  destination paths, Docker identities, provider output, or evidence bytes
  through this boundary, and it is not barrel-exported. Helper verification is
  contract-bound and image-based: the image projection must include exact
  helper contract label, either an immutable registry reference or a Spawnfile-attested
  local image config digest, exact expected immutable entrypoint,
  empty `Cmd`, non-root `User`, and only the fixed nonsecret
  `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  environment entry before any container create/inspect/replay.
  Helper-container enforcement is fixed and isolated: `network none`, read-only
  root, no restart/logging/ports, bounded CPU/memory/pids, deterministic
  `volume-nocopy` mount, and explicit empty user/group/device/network-related
  fields. `UsernsMode` is not required or forced; container user namespaces are
  daemon-policy, not assumed. Private cleanup/retry uses deterministic-name
  inspect-only recovery, and foreign collision is never removed.
- `Evidence archives` are parsed as strict canonical POSIX USTAR: exact
  `ustar\0` magic, `00` version, canonical checksums, canonical octal fields,
  exact path normalization, canonical directory/file metadata, exactly two final
  zero blocks, and no trailing data or malformed extensions.
- `index.ts` is the public barrel for this boundary.
- Tests prove hostile input rejection and exact public serialization.

Keep this public boundary independent of Docker, CLI, runtime, organization, world, and
simulation behavior. Public values are bounded identifiers, canonical digests,
and opaque handles only; private provider records and resource mappings must
never cross this boundary.
