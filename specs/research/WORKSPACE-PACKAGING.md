# Source directories and shared toolsets

Status: agreed design direction; not implemented.
Updated: 2026-09-12.
This is informative design work, not a change to the v0.1 source contract.
Example field names below are provisional and are not accepted by the current
schema. The implementation must update the normative specs when it lands.

## Authoring goal

An agent declaration should name its identity, model overrides, schedule,
communication surfaces, memory and allowed tools. Authors keep tool source and
instructions as ordinary files. Packaging, checksums and resolved runtime paths
belong in generated build output rather than repeated agent declarations.

```text
Source + package recipe ─→ Spawnfile build ─→ hashed deployment artifact
```

Build reproducibility and per-agent authority remain explicit requirements.
This changes authoring and deployment preparation, not agent choreography.

## What already exists

| Capability | Current behavior |
| --- | --- |
| Shared resources | `shared.workspace.resources` is inherited; common resource declarations need not be repeated for every direct team member |
| Workspace resources | The implementation accepts `git`, `volume` and read-only `bundle` resources |
| Offline bundles | A bundle requires a prebuilt safe tar, its exact SHA-256 and mount; compilation verifies and copies its bytes |
| MCP tools | Declarations already describe MCP servers and tool selections; shorthand must lower to those existing runtime contracts |
| Source manifests | Runtime build helpers already produce file-level provenance manifests; this is not yet a public directory-resource feature |

Implementation references: [workspace schema](../../src/manifest/workspaceSchemas.ts),
[resource inheritance](../../src/compiler/workspaceResources.ts),
[bundle validation](../../src/compiler/workspaceBundleArtifacts.ts),
[MCP schema](../../src/manifest/mcpSchemas.ts) and
[source provenance helper](../../scripts/source-provenance-bundle.ts).
See [offline workspace bundles](../CONTAINERS.md#offline-workspace-bundles).

## Proposed authoring experience

The team declares common defaults and makes a named tool package available.
Each agent selects only the operations it needs.

**Illustrative team excerpt — proposed syntax, not runnable today:**

```yaml
kind: team
name: field-notes
lead: editor

runtime:
  name: daimon
  options:
    engine: codex

execution:
  model:
    primary:
      provider: openai
      name: gpt-5.5
      auth: { method: codex }

toolsets:
  reporting:
    source: ../private-tools/reporting
```

**Illustrative agent excerpt — proposed syntax, not runnable today:**

```yaml
kind: agent
name: reporter

workspace:
  docs:
    soul: SOUL.md
    system: AGENTS.md

schedule:
  kind: cron
  cron: "0 13 * * *"
  timezone: Europe/Berlin
  jitter_seconds: 900
  prompt_file: PITCH.md

tools:
  reporting:
    - validate_article
    - file_article
```

These excerpts omit the existing version, membership, surface and memory
declarations; they do not redefine those contracts. `toolsets`, per-agent
`tools` shorthand and `prompt_file` are proposed additions. Local directory
resources are part of this direction, but their exact schema is undecided.
There is no new general-purpose `defaults` shorthand in this proposal.

A tool package describes its exported operations, MCP entry points,
dependencies and explicit build recipe. It may adapt several existing MCP
servers. The author should not have to copy generated absolute workspace paths
or archive checksums into each member's Spawnfile.

A file-backed scheduled prompt resolves from its declaring manifest's scope
and is captured in the compiled identity. It moves long instructions out of
YAML without changing when agents wake or how their turns execute.

## Ownership and build behavior

| Owner | Responsibility |
| --- | --- |
| Tool package | Tool source, exported operations, dependency locks, declared build recipe and outputs |
| Spawnfile compile | Resolve source paths, inheritance, requested operations and runtime support; report errors without running arbitrary package build commands |
| Spawnfile build | Prepare the declared inputs, run explicit build recipes, package outputs, compute identities and retain reusable artifacts |
| Spawnfile deployment | Verify and deploy the built artifact without rereading changed source files or rebuilding it implicitly |
| Daimon / runtime adapter | Expose the selected tools and agent identity through supported runtime contracts; do not discover or build the organization |
| Tool server | Enforce the caller's allowed operations and identity for its actions |
| Moltnet | Carry coordination messages; no packaging, scheduling or tool authorization ownership |

Reuse existing safe-archive, provenance and runtime-tool contracts where they
fit. Keep the feature generic; application-specific source selection and build
logic stay in the consuming project's tool package. No changes to Mneme,
Moltnet or Stele are required merely to improve this authoring experience.

### Hash files automatically; keep packages as transport

The builder records a deterministic manifest of the selected relative paths,
entry types, relevant modes, content hashes and permitted link targets.
Resource identity also binds the selection rules, build recipe, dependency
locks, target platform and declared toolchain inputs. Built outputs receive
their own identity; input hashes alone do not prove output bytes.

A digest of that manifest identifies the selected input tree. Authors do not
maintain individual file hashes. A tar, image layer or another supported
container for bytes can still transport the result; its exact bytes are
verified at deployment. Hashes and archives solve different problems.

Source roots and exclusions must be explicit. Credentials, private runtime
state, memories, caches and generated output are not swept into a tool package.
Escaping paths/links, undeclared input reads and source changes during capture
must fail or restart capture rather than produce misleading provenance.
Native dependencies must be prepared for the declared deployment platform,
not inherited accidentally from the developer's installed packages.

The build recipe's execution and network policy must be declared and enforced.
A source declaration alone must never grant arbitrary build execution or
access to runtime credentials. A build receipt records the actual inputs and
outputs; deployment consumes the sealed result.

### Shared installation does not grant shared authority

One tool package can supply a writer, reviewer and compositor. Selecting the
writer's tools must not authorize the reviewer's operations. Installing common
code, deduplicating archive storage and granting tool access are separate acts.

The compiler resolves explicit tool selections and rejects unknown operations.
The runtime adapter and tool server enforce the selected surface with the
calling agent's identity. Tool-list filtering or prompt instructions alone are
not an authorization guarantee; a bypass or forged caller identity must fail.
An adapter unable to enforce a required boundary must report it and refuse an
enforcement-required deployment.

Physical caching or deduplication must not merge agent homes, credentials,
mutable tool state or memory. This proposal does not require one shared MCP
process. Existing shared product-state volumes remain shared only as declared.

### Frozen deployment and compatibility

Existing prebuilt bundle declarations remain supported. Generated artifacts
stay outside authored source; versioned identities remain in build output.
Whether an optional generated lockfile also records resolved remote inputs is
an open schema decision, not a requirement to rewrite agent files.

Changing a reference document may invalidate its containing source resource.
It must not require editing every agent's declaration. A new build explicitly
refreshes the snapshot; a Git push does not hot-reload running agents.
Reattaching durable edition state, agent memory and network history must
preserve their existing identities and contents.

## Acceptance checks before migration

1. Build a local source package without a manually prepared tar or per-agent
   checksums; the generated artifact is usable offline on the declared target.
2. Change, add, delete or rename a selected file, alter its relevant mode, or
   change the recipe/lock/target: the corresponding identity changes. Preserve
   a digest while changing bytes and verification must reject the artifact.
3. Change the live source after building: deployment uses the sealed build.
   Deliberate rebuild captures the change; deployment never silently rebuilds.
4. Share one package between two agents with different selections. A direct
   attempt to invoke an excluded operation or impersonate the other agent is
   denied; authorized calls retain the correct attribution.
5. Preserve per-agent identity, memory, credentials and declared shared state
   through migration and replacement. No implicit new authority or state reset.
6. Verify existing bundle projects still compile and deploy, and compare the
   new directory/toolset project with an equivalent legacy deployment.
7. Read a scheduled prompt from its file with the same schedule, timezone and
   jitter; changing the file updates compiled identity without new wake logic.

These are future implementation acceptance cases, not tests claimed to pass
today. Each guarantee needs a failure case that goes red when removed.

## Decisions still required before implementing the schema

- Exact directory-resource and toolset declarations, package metadata format,
  selection/exclusion rules and supported build recipe interface.
- How tool selection inherits, how conflicting exports are diagnosed, and how
  each adapter proves enforcement without introducing a new organization API
  into a per-agent runtime.
- Generated artifact/lockfile format, cache identity and file-backed prompt
  precedence when an inline prompt is also supplied.

Implement source capture and packaging first, then toolset lowering and
file-backed prompts. Migrate a consuming project only after the relevant
compatibility, denial and durable-state checks pass. Keep its live declarations
on the supported schema until then.
