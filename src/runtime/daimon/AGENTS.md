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
The usage ledger is provisioned for any organization containing a metered
engine — AGY or Grok — and its mount id stays `daimon-grok-usage-ledger`
because the id is the volume identity and renaming it orphans existing data.

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
