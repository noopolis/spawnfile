import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openClawAdapter } from "../runtime/openclaw/adapter.js";
import { daimonAdapter } from "../runtime/daimon/adapter.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "../runtime/daimon/contractManifest.js";

import { createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import { createExclusiveReattachVolumeName } from "../shared/index.js";
import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const temporaryDirectories: string[] = [];
const useCompatibleDaimonRuntime = async (): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-plan-daimon-"));
  temporaryDirectories.push(directory);
  const identity = path.join(directory, "identity.json");
  const digest = `sha256:${"a".repeat(64)}`;
  await writeFile(identity, `${JSON.stringify({
    capability_receipt_sha256: digest,
    development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    image_architecture: "amd64",
    image_config_digest: digest,
    image_manifest_digest: digest,
    image_reference: `127.0.0.1:54321/noopolis/spawnfile-runtime-daimon@${digest}`,
    manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256,
    registry_authority: "127.0.0.1:54321",
    version: "spawnfile.local-daimon-runtime-identity.v3"
  })}\n`, { mode: 0o600 });
  process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = identity;
};

afterEach(async () => {
  delete process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

const createAgent = (): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/assistant/Spawnfile",
  subagents: []
});

const createTeam = (): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name: "group",
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: "/tmp/group/Spawnfile"
});

describe("runtime target plan source identity", () => {
  it("derives an omitted compiled-node id from its kind and slug", async () => {
    const node = createAgent();
    const compiled = await openClawAdapter.compileAgent(node);
    const plan: CompilePlan = {
      edges: [],
      nodes: [],
      root: "/tmp/Spawnfile",
      runtimes: { openclaw: { nodeIds: [] } }
    };
    const result = await createRuntimeTargetPlans(plan, [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      },
      {
        emittedFiles: [{ content: "{}\n", path: "openclaw.json" }],
        kind: "team",
        runtimeName: "openclaw",
        slug: "group",
        value: createTeam()
      }
    ]);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual(expect.objectContaining({
      id: "agent-assistant",
      sourceIds: ["agent:assistant"]
    }));
    expect(result).toContainEqual(expect.objectContaining({
      id: "team-group",
      sourceIds: ["team:group"]
    }));
  });

  it("keeps an empty Daimon workspace in the one organization target", async () => {
    await useCompatibleDaimonRuntime();
    const node: ResolvedAgentNode = {
      ...createAgent(),
      runtime: { name: "daimon", options: { engine: "agy" } }
    };
    const compiled = await daimonAdapter.compileAgent(node);
    expect(compiled.files).toEqual([]);

    const priorRunId = process.env.NOOPOLIS_RUN_ID;
    process.env.NOOPOLIS_RUN_ID = "candidate-blue";
    let result: Awaited<ReturnType<typeof createRuntimeTargetPlans>>;
    try {
      result = await createRuntimeTargetPlans({
        edges: [],
        nodes: [],
        root: "/tmp/Spawnfile",
        runtimes: { daimon: { nodeIds: [] } }
      }, [{
        emittedFiles: compiled.files,
        id: "agent:assistant",
        kind: "agent",
        runtimeName: "daimon",
        slug: "assistant",
        value: node
      }]);
    } finally {
      if (priorRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = priorRunId;
    }

    expect(result).toContainEqual(expect.objectContaining({
      engineByNodeId: { "agent:assistant": "agy" },
      id: "daimon-organization",
      modelAuthMethods: {},
      modelSecretsRequired: [],
      opaqueMountTargets: ["/var/lib/spawnfile/daimon/agy-unlock-secret"],
      persistentMounts: [
        {
          id: "daimon-agy-runtime-home-assistant",
          mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/assistant",
          reason: "Daimon AGY subscription runtime home for agent:assistant",
          volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-agy-runtime-home-assistant", "candidate-blue")
        },
        {
          // Run-id-free by construction. `createPersistentVolumeName` folds the
          // run id in, so the previous (lifecycle-less) name changed on every
          // `spawnfile up` and handed the container an empty keyring — meaning
          // the interactive AGY browser OAuth had to be redone each deploy.
          id: "daimon-agy-subscription-realm",
          lifecycle: "exclusive-reattach",
          mount_path: "/var/lib/spawnfile/daimon/agy-subscription-realm",
          reason: "Daimon host AGY subscription realm",
          volume_name: createExclusiveReattachVolumeName("/tmp/Spawnfile\u0000compile", "daimon-agy-subscription-realm")
        },
        {
          // An AGY-only organization meters its turns too, so it gets the
          // ledger volume that used to be provisioned only for Grok.
          id: "daimon-grok-usage-ledger",
          lifecycle: "exclusive-reattach",
          mount_path: "/var/lib/spawnfile/daimon/usage",
          reason: "Daimon per-turn engine usage ledger",
          volume_name: createExclusiveReattachVolumeName("/tmp/Spawnfile\u0000compile", "daimon-grok-usage-ledger")
        },
        {
          id: "daimon-organization-acceptance-store",
          mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/state/wake-acceptance",
          reason: "Daimon organization durable wake acceptance store",
          volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-organization-acceptance-store", "candidate-blue")
        },
        {
          id: "daimon-tool-state-assistant",
          mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/assistant/tool-state",
          reason: "Daimon durable cognition tool receipts for agent:assistant",
          volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-tool-state-assistant", "candidate-blue")
        }
      ]
    }));
  });

  it("assigns stable isolated volumes to portable Daimon engine homes", async () => {
    await useCompatibleDaimonRuntime();
    const agents = ([
      ["writer", "codex"],
      ["scout", "grok"]
    ] as const).map(([slug, engine]) => ({
      node: {
        ...createAgent(),
        name: slug,
        runtime: { name: "daimon", options: { engine } }
      } as ResolvedAgentNode,
      slug
    }));
    const compiled = await Promise.all(agents.map(async ({ node, slug }) => ({
      emittedFiles: (await daimonAdapter.compileAgent(node)).files,
      id: `agent:${slug}`,
      kind: "agent" as const,
      runtimeName: "daimon",
      slug,
      value: node
    })));
    const result = await createRuntimeTargetPlans({
      edges: [],
      nodes: [],
      root: "/tmp/Spawnfile",
      runtimes: { daimon: { nodeIds: [] } }
    }, compiled);

    expect(result[0]?.persistentMounts).toEqual([
      {
        id: "daimon-engine-home-codex-writer",
        mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/writer/.codex",
        reason: "Daimon codex subscription credential home for agent:writer",
        volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-engine-home-codex-writer")
      },
      {
        id: "daimon-engine-home-grok-scout",
        mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/scout/.grok",
        reason: "Daimon grok subscription credential home for agent:scout",
        volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-engine-home-grok-scout")
      },
      {
        id: "daimon-grok-subscription-realm",
        lifecycle: "exclusive-reattach",
        mount_path: "/var/lib/spawnfile/daimon/grok-subscription-realm",
        reason: "Daimon host Grok subscription credential realm",
        volume_name: expect.stringMatching(/^spawnfile-exclusive-daimon-grok-subscription-realm-[a-f0-9]{16}$/u)
      },
      {
        // Run-scoping this volume threw the ledger away on every redeploy: a
        // fresh `spawnfile up` minted a new run id and therefore a new empty
        // volume, so `spawnfile usage` could never report across deployments.
        // Its single-writer, size-rotating append log is exactly the shape
        // `exclusive-reattach` exists for.
        id: "daimon-grok-usage-ledger",
        lifecycle: "exclusive-reattach",
        mount_path: "/var/lib/spawnfile/daimon/usage",
        reason: "Daimon per-turn engine usage ledger",
        volume_name: expect.stringMatching(/^spawnfile-exclusive-daimon-grok-usage-ledger-[a-f0-9]{16}$/u)
      },
      {
        id: "daimon-organization-acceptance-store",
        mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/state/wake-acceptance",
        reason: "Daimon organization durable wake acceptance store",
        volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-organization-acceptance-store")
      },
      {
        id: "daimon-tool-state-scout",
        mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/scout/tool-state",
        reason: "Daimon durable cognition tool receipts for agent:scout",
        volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-tool-state-scout")
      },
      {
        id: "daimon-tool-state-writer",
        mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/writer/tool-state",
        reason: "Daimon durable cognition tool receipts for agent:writer",
        volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-tool-state-writer")
      }
    ]);
    expect(JSON.stringify(result[0]?.persistentMounts)).not.toMatch(/daimon-inbound|access_token|refresh_token/u);
  });
});
