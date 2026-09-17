import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { daimonAdapter } from "../runtime/daimon/adapter.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256, DAIMON_GROK_ENGINE_BROKER, DAIMON_GROK_SUBSCRIPTION_REALM, DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";
import { DAIMON_WAKE_FUSE_DIRECTORY } from "../runtime/daimon/config.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import { resolveDaimonGrokRegistrations } from "./containerDaimonGrokWorkerRender.js";
import { resolveDaimonUidEntrypointOwnershipPlan } from "./containerDaimonUidEntrypointRender.js";
import { MOLTNET_READINESS_DIRECTORY } from "./containerReadinessPaths.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";
import { createMoltnetDaimonReceiptStorePath, createMoltnetNetworkStateDirectory, createMoltnetOpenTokenPath } from "./moltnetConfigLowering.js";
import type { CompilePlan, ResolvedAgentNode } from "./types.js";

const INSTANCE = "/var/lib/spawnfile/instances/daimon/daimon-organization";
const temporary: string[] = [];
afterEach(async () => {
  delete process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY;
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const useCompatibleDaimonRuntime = async (): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-deny-coverage-"));
  temporary.push(directory);
  const identity = path.join(directory, "identity.json"), digest = `sha256:${"a".repeat(64)}`;
  await writeFile(identity, `${JSON.stringify({
    capability_receipt_sha256: digest, development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    image_architecture: "amd64", image_config_digest: digest, image_manifest_digest: digest,
    image_reference: `127.0.0.1:54321/noopolis/spawnfile-runtime-daimon@${digest}`, manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256,
    registry_authority: "127.0.0.1:54321", version: "spawnfile.local-daimon-runtime-identity.v3"
  })}\n`, { mode: 0o600 });
  process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = identity;
};

const agent = (name: string, engine: string): ResolvedAgentNode => ({
  description: "", docs: [], env: {}, kind: "agent", mcpServers: [], name, policyMode: null, policyOnDegrade: null,
  runtime: { name: "daimon", options: { engine } }, secrets: [], skills: [], source: `/tmp/${name}/Spawnfile`, subagents: [],
  execution: engine === "grok" ? { model: { primary: { auth: { method: "grok" }, name: "grok-4.6", provider: "xai", reasoning_effort: "low" } } }
    : engine === "codex" ? { model: { primary: { auth: { method: "codex" }, name: "gpt-5.4-mini", provider: "openai" } } } : undefined
} as ResolvedAgentNode);

const resource = (id: string, linkPath: string, backingPath: string) => ({ backingPath, id, kind: "git" as const, linkPath, mode: "readonly" as const, mount: `./${id}`, sharing: "agent" as const });

const plans = async (): Promise<RuntimeTargetPlan[]> => {
  await useCompatibleDaimonRuntime();
  const nodes = [["alpha", "grok"], ["beta", "grok"], ["gamma", "codex"], ["delta", "agy"]] as const;
  const compiled = await Promise.all(nodes.map(async ([slug, engine]) => {
    const value = agent(slug, engine);
    return { emittedFiles: (await daimonAdapter.compileAgent(value)).files, id: `agent:${slug}`, kind: "agent" as const, runtimeName: "daimon", slug, value };
  }));
  const [daimon] = await createRuntimeTargetPlans({ edges: [], nodes: [], root: "/tmp/Spawnfile", runtimes: { daimon: { nodeIds: [] } } } as unknown as CompilePlan, compiled);
  const withResources: RuntimeTargetPlan = {
    ...daimon!,
    persistentMounts: [...(daimon!.persistentMounts ?? []), { id: "memory-bank", mount_path: "/var/lib/spawnfile/memory/alpha/notes", reason: "memory", volume_name: "memory" }],
    resources: [
      resource("own", `${INSTANCE}/workspace/agents/alpha/own`, "/var/lib/spawnfile/resources/instances/daimon-organization/own"),
      resource("peer", `${INSTANCE}/workspace/agents/beta/peer`, "/var/lib/spawnfile/resources/instances/daimon-organization/peer"),
      resource("team", `${INSTANCE}/workspace/agents/alpha/team`, "/var/lib/spawnfile/resources/teams/crew/team"),
      resource("team", `${INSTANCE}/workspace/agents/gamma/team`, "/var/lib/spawnfile/resources/teams/crew/team")
    ] as unknown as RuntimeTargetPlan["resources"]
  };
  const sibling = {
    envFiles: [{ envName: "PICO_KEY", filePath: "/var/lib/spawnfile/instances/picoclaw/pico/picoclaw/.env" }],
    instancePaths: { configPath: "/var/lib/spawnfile/instances/picoclaw/pico/picoclaw/config.json", instanceRoot: "/var/lib/spawnfile/instances/picoclaw/pico", workspacePath: "/var/lib/spawnfile/instances/picoclaw/pico/workspace" },
    persistentMounts: [{ id: "pico-state", mount_path: "/var/lib/spawnfile/instances/picoclaw/pico/home", reason: "state", volume_name: "pico" }],
    runtimeName: "picoclaw"
  } as unknown as RuntimeTargetPlan;
  return [withResources, sibling];
};

const within = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}/`);

describe("Grok worker deny coverage over everything the Daimon container provisions", () => {
  it("denies every provisioned state path except the agent's own, explicitly justified ones", async () => {
    const runtimePlans = await plans();
    const moltnet = {
      nodePlans: [{ configPath: "/var/lib/spawnfile/moltnet/nodes/crew-net-alpha.json", receiptStorePath: createMoltnetDaimonReceiptStorePath("net", "alpha") }],
      serverPlans: [{ configPath: "/var/lib/spawnfile/moltnet/servers/local/Moltnet.json", mode: "managed" }]
    } as unknown as EntrypointOptions["moltnet"];
    const persistentMountPaths = runtimePlans.flatMap((plan) => (plan.persistentMounts ?? []).map((mount) => mount.mount_path));
    const ownership = resolveDaimonUidEntrypointOwnershipPlan(runtimePlans, persistentMountPaths, moltnet);
    const registrations = resolveDaimonGrokRegistrations(runtimePlans);
    const provisioned = [...new Set([
      ...ownership.stateRoots, ...ownership.privateDirectories, ...ownership.privateFiles, ...ownership.privateModeDirectories,
      ...ownership.opaqueDescendantRoots, ...ownership.creatablePrivateDirectories.map((entry) => entry.target),
      ...persistentMountPaths, ...runtimePlans.flatMap((plan) => plan.opaqueMountTargets ?? []),
      ...runtimePlans.flatMap((plan) => [plan.instancePaths.configPath, ...(plan.envFiles ?? []).map((file) => file.filePath)]),
      ...runtimePlans.flatMap((plan) => plan.resources ?? []).flatMap((entry) => [entry.backingPath, entry.linkPath]),
      MOLTNET_READINESS_DIRECTORY, createMoltnetNetworkStateDirectory("net"), createMoltnetOpenTokenPath("net", "alpha"), "/var/lib/spawnfile/moltnet/servers",
      DAIMON_GROK_ENGINE_BROKER.registrationPath, DAIMON_GROK_ENGINE_BROKER.serviceConfigPath, DAIMON_GROK_ENGINE_BROKER.controlSocketPath,
      DAIMON_GROK_ENGINE_BROKER.backendSocketPath, DAIMON_GROK_ENGINE_BROKER.launcherSocketPath, DAIMON_GROK_ENGINE_BROKER.turnStorePath,
      DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath, DAIMON_GROK_TURN_USAGE_LEDGER.filePath, DAIMON_WAKE_FUSE_DIRECTORY,
      ...registrations.map((entry) => entry.home), "/run/secrets", "/run/spawnfile-secrets/token", "/run/world/evidence"
    ])].filter((entry) => entry.startsWith("/"));

    for (const registration of registrations) {
      const slug = registration.agentId.replace(/^agent:/u, "");
      const ownRuntimeHome = `${INSTANCE}/runtime-homes/${slug}`;
      const own = [registration.workspace, registration.home, ...runtimePlans.flatMap((plan) => plan.resources ?? [])
        .filter((entry) => within(entry.linkPath, registration.workspace)).map((entry) => entry.backingPath)];
      /** Directories whose only provisioned children are separately denied; listing them reveals names, not content. */
      const justified = new Map([
        [`${INSTANCE}/state`, "sole child is the denied wake-acceptance store"],
        ["/var/lib/spawnfile/daimon", "shared parent; every realm, ledger, fuse and bootstrap child is denied"],
        [ownRuntimeHome, "Daimon names tool-result spill paths under it; every mount inside it is denied"],
        ["/var/lib/spawnfile/instances/picoclaw", "runtime-kind parent of another runtime's denied instance root"]
      ]);
      const uncovered = provisioned.filter((entry) =>
        !registration.denyPaths.some((denied) => within(entry, denied))
        && !own.some((allowed) => within(entry, allowed))
        && ![...own, ownRuntimeHome].some((allowed) => allowed.startsWith(`${entry}/`))
        && !justified.has(entry));
      expect(uncovered, registration.agentId).toEqual([]);
      for (const moltnetPath of ["/var/lib/spawnfile/moltnet", "/var/lib/spawnfile/agents", "/var/lib/spawnfile/memory"]) expect(registration.denyPaths).toContain(moltnetPath);
    }
    const [alpha, beta] = registrations;
    expect(alpha!.denyPaths).toContain("/var/lib/spawnfile/resources/instances/daimon-organization/peer");
    expect(alpha!.denyPaths).not.toContain("/var/lib/spawnfile/resources/instances/daimon-organization/own");
    expect(alpha!.denyPaths).not.toContain("/var/lib/spawnfile/resources/teams/crew/team");
    expect(beta!.denyPaths).toEqual(expect.arrayContaining([
      "/var/lib/spawnfile/resources/instances/daimon-organization/own", "/var/lib/spawnfile/resources/teams/crew/team"
    ]));
    expect(beta!.denyPaths).not.toContain("/var/lib/spawnfile/resources/instances/daimon-organization/peer");
    expect(alpha!.deferredDenyPaths).toEqual(["/var/lib/spawnfile/resources/instances/daimon-organization/peer"]);
    expect(alpha!.denyPaths).toEqual(expect.arrayContaining([`${INSTANCE}/runtime-homes/alpha/tool-state`, `${INSTANCE}/runtime-homes/alpha/.grok`, `${INSTANCE}/daimon`, "/var/lib/spawnfile/instances/picoclaw/pico"]));
    for (const entry of alpha!.denyPaths) expect(alpha!.denyPaths.some((other) => other !== entry && within(entry, other))).toBe(false);
  });
});
