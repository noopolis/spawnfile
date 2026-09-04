# Daimon Runtime Adapter

This folder lowers a resolved Spawnfile organization into the public
`noopolis.daimon.organization-runtime.v1` contract. It owns no model CLI
argv, credential copying, MCP process, scheduler, or Moltnet
bridge code. Daimon owns one wake at a time after this adapter has prepared
the organization artifact.

Keep the generated configuration strict and source-free. The adapter emits
one organization host target (at most 32 agents), not one generated engine
application per agent. It permits only compiler-owned Moltnet public-wake
attachments; Daimon consumes a generic 0700 private ingress itself. `runtime:
pi` remains the legacy generated Pi path.

The consumed Daimon manifest declares stable AGY and Grok host-realm volumes
plus their opaque bootstrap slots. This adapter renders those resources but
never starts a provider CLI, D-Bus, or a turn.

Both host-realm volumes and the per-turn usage ledger carry
`lifecycle: "exclusive-reattach"`. That is not decoration: without it the
volume name folds in the run id (`createPersistentVolumeName`), so a fresh
`spawnfile up` gets an empty volume. For the AGY realm that means an empty OS
keyring and a repeat of the interactive browser OAuth, which has no headless
equivalent; for the ledger it means cross-deployment accounting is impossible.
The usage ledger is provisioned unconditionally, for every Daimon
organization — Codex writes its advisory per-turn usage here too, not just
AGY and Grok, and Daimon's wake fuse now refuses to arm at all if this
directory is missing or unreadable (`ensureUsageLedgerReadable` in Daimon's
`wakeFuse.ts`). Its mount id stays `daimon-grok-usage-ledger` because the id
is the volume identity and renaming it orphans existing data. The container
entrypoint also fixes this directory group-writable (`0770`, not `0750`):
Codex and AGY write from the organization-uid runtime process
(`renderDaimonUsageLedgerProvisioning` in `containerDaimonBrokerRender.ts`),
not the Grok-only broker, so a mode granting the group only read+execute lets
that process list the directory but not create `usage.jsonl` inside it. That
fix-up is `chown root, chmod, chown to the final broker:organization owner`
— in that order, never `install -d`'s create-then-chown-then-chmod — because
root only ever chmods a path it currently owns: it has `CAP_CHOWN` but not
`CAP_FOWNER` (`runProject.ts`'s capability set), so chmod-ing *after* handing
ownership to the broker uid fails closed with `EPERM`. And it never creates
the directory itself: `/var/lib/spawnfile/daimon` (the shared parent every
Daimon-under-`/var/lib/spawnfile/daimon` mount lives under — AGY/Grok realms,
wake fuse, broker realm, this ledger) must stay a shared, root-owned,
universally traversable ancestor (`secureFixedTraversalAncestor`,
`containerDaimonOwnershipGuardRender.ts`), never chowned to the organization
uid by the generic per-mount ancestor walk that every other private directory
goes through — an organization with an AGY or Grok agent would otherwise
leave that shared parent owned by the organization uid as a side effect of
securing its own realm mount, which then blocks *every other* differently-owned
child (concretely, this ledger) from ever being created there at all.

All three engines lower declared MCP servers and Moltnet surfaces. AGY was
excluded until Daimon learned to register its per-wake MCP endpoint through
`agy mcp add`; the compiler-side MCP validations (explicit tools allowlist,
absolute stdio command) are engine-independent and still apply.

The consumed manifest also pins the native Grok broker source/x64/arm64
digests, fixed root/org/broker/worker identities, root-only registrations,
and loopback-only provider/MCP endpoints. Container provisioning must match
that authority exactly and must not publish either broker port.

Codex keeps an isolated per-agent credential home. Grok keeps isolated
per-agent non-auth state but one durable rotating subscription credential
realm; never fan out Grok refresh authority across writable homes.

Memory lowering is `memory.ts`'s `resolveDaimonAgentMemory` (split out of
`config.ts` to stay inside the 400-line source bound, and re-exported from
`config.ts` so existing importers are unaffected). Daimon accepts one
`memory` block per agent (`{ runtimeHomePath, source?, tokenBudget? }`, camelCase,
no unknown keys), so this adapter picks a single declared bank deterministically
and emits it only when `resolveMnemeDurableMemoryMountPath` (`../mnemeMcp.ts`)
says the compiler mounts a durable volume for it. That predicate is shared with
`src/compiler/memoryArtifacts.ts` on purpose: a runtime home with no persistent
mount is absent or root-owned inside the container, so an in-process Mneme
runtime pointed at one fails its first write. Everything else -- postgres,
in-process `memory` stores, ephemeral persistence, or a second declared bank --
stays a `degraded` memory capability with no emitted block.

That block carries no embedding configuration, and Daimon's CLI harness never
sets `memory.embeddingProvider`, so vector recall does not exist on this
runtime. A bank declaring `index.vector.enabled` still compiles and still
recalls -- lexically. `daimonMemoryVectorRecallWarning` says so as a compile
diagnostic and degrades the memory capability, because the alternative is a
declaration that is accepted verbatim and quietly means something else.
Forwarding the configuration instead would mean widening the digest-pinned
organization runtime contract and building an embedding provider in daimon.

`restrict_to_workspace` has the same shape of problem and the same answer.
`validateRuntimeOptions` allowlists it beside `engine`, and nothing under this
folder reads it: the organization runtime contract carries no
workspace-confinement field. PicoClaw lowers an identically named option for
real, which is what makes it look wired here.
`daimonWorkspaceRestrictionWarning` (in `adapter.ts`, next to the other compile
diagnostics) names the agent, states that the option reaches no runtime
behavior, and points at the picoclaw runtime as the way to actually get it.
Warn, never reject -- a project already declaring the option has to keep
compiling -- and never silently drop it, because a security option that is
accepted and ignored is worse than one that is refused. Implementing real
confinement is a daimon sandbox-profile change plus a contract widening, not an
adapter change.

## Credential ownership is a deploy-time contract

`runtimeIdentity.ts` is the single source of truth for the fixed container-side
uids a compiled Daimon image runs under (`DAIMON_ORGANIZATION_UID`,
`DAIMON_BROKER_UID`, `DAIMON_FIRST_WORKER_UID`);
`src/compiler/containerDaimonBrokerRender.ts` re-exports them so the compiler and
the deploy path cannot drift apart. They are compiler-wide constants, not
per-organization values: the rendered entrypoint pins `uid=2000` and drops to it
with `setpriv --reuid`.

That number leaks into the *host* because Daimon validates a credential file's
owner against its own `process.getuid()` inside the container
(`portableCredentialMaterial.ts` for the Codex leaf, `agySubscriptionRealm.ts`
for the AGY unlock secret), Spawnfile bind-mounts those files read-only with no
ownership remapping, and both leaves are declared `opaqueMountTargets` so the
entrypoint ownership guard deliberately never chowns them. A host file therefore
keeps its host uid inside the container.

`runAuth.ts` consequently imposes two separate gates on the same file and both
must hold:

- `isUnsafeDaimonSourceFile` — the host gate. One bounded 0600 regular file with
  a single hard link, owned by the calling process, and never a root caller
  (`callerUid <= 0` is refused outright so a privileged process cannot launder
  credential material it does not own). Do not relax either clause.
- `assertDaimonCredentialContainerOwner` — the container gate, checked at deploy
  time so an owner mismatch is refused by `spawnfile up` with both uids named,
  instead of surfacing as `credential materialization failed` inside a candidate
  container that lives about fifteen seconds.

The Grok bootstrap leaf is deliberately exempt from the second gate: nothing in
the organization runtime process reads it (the live Grok path goes through the
engine broker, which runs under `DAIMON_BROKER_UID` and reads only its durable
realm), so pinning it to the organization uid would refuse deployments that work
today.

Materializing the credential host-side instead of checking it is not available:
copying it to a file owned by uid 2000 needs `CAP_CHOWN`, and the host gate
refuses a root caller by design.
