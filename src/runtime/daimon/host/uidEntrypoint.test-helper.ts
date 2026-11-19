import { createDaimonWorkerDetails } from "./targetDetails.js";
import type { RuntimeTargetPlan } from "../../../compiler/containerArtifactsTypes.js";
import type { EntrypointOptions } from "../../../compiler/containerEntrypointRender.js";

export const authorizedUid = 2000;

export const daimonPlan: RuntimeTargetPlan = {
  engineByNodeId: { "agent:AGY": "agy", "agent:Codex One": "codex", "agent:Grok Two": "grok" },
  hostDetails: createDaimonWorkerDetails({ modelByNodeId: { "agent:Grok Two": { model: "grok-4.6", reasoningEffort: "low" } } }),
  envFiles: [], id: "daimon-organization",
  instancePaths: {
    configPath: "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/config.json",
    instanceRoot: "/var/lib/spawnfile/instances/daimon/daimon-organization",
    workspacePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace"
  },
  meta: { configFileName: "config.json", instancePaths: { configPathTemplate: "", workspacePathTemplate: "" }, standaloneBaseImage: "node:24", startCommand: [], systemDeps: [] },
  modelAuthMethods: {}, modelSecretsRequired: [], opaqueMountTargets: ["/var/lib/spawnfile/daimon/agy-unlock-secret"],
  runtimeName: "daimon", runtimeRoot: "/opt/daimon", targetFiles: []
};

export const serverConfig = "/var/lib/spawnfile/moltnet/servers/local/Moltnet.json";

export const nodeConfig = "/var/lib/spawnfile/moltnet/nodes/agent.json";

export const causalState = "/var/lib/spawnfile/moltnet/servers/local/causal";

export const agyRealm = "/var/lib/spawnfile/daimon/agy-subscription-realm";

export const agyRuntimeHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy";

export const codexEngineHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex-one/.codex";

export const grokEngineHome = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok-two/.grok";

export const acceptanceStore = "/var/lib/spawnfile/instances/daimon/daimon-organization/state/wake-acceptance";

export const acceptanceStoreMount = {
  id: "daimon-organization-acceptance-store",
  mount_path: acceptanceStore,
  reason: "Daimon organization durable wake acceptance store",
  volume_name: "spawnfile-test-daimon-acceptance-store"
};

export const agyRealmMount = {
  id: "daimon-agy-subscription-realm",
  mount_path: agyRealm,
  reason: "Daimon host AGY subscription realm",
  volume_name: "spawnfile-test-agy-realm"
};

export const agyRuntimeHomeMount = {
  id: "daimon-agy-runtime-home-agy",
  mount_path: agyRuntimeHome,
  reason: "Daimon AGY subscription runtime home for agent:agy",
  volume_name: "spawnfile-test-agy-runtime-home"
};

export const codexEngineHomeMount = {
  id: "daimon-engine-home-codex-codex-one",
  mount_path: codexEngineHome,
  reason: "Daimon codex subscription credential home for agent:Codex One",
  volume_name: "spawnfile-test-codex-engine-home"
};

export const grokEngineHomeMount = {
  id: "daimon-engine-home-grok-grok-two",
  mount_path: grokEngineHome,
  reason: "Daimon grok subscription credential home for agent:Grok Two",
  volume_name: "spawnfile-test-grok-engine-home"
};

export const moltnetPlans = {
  nodePlans: [{ configPath: nodeConfig, networkId: "local" }],
  serverPlans: [{
    baseUrl: "http://127.0.0.1:8787",
    configPath: serverConfig,
    id: "local",
    mode: "managed" as const,
    name: "Local",
    networkId: "local",
    port: 8787,
    rooms: [],
    secretPatches: [],
    server: {
      auth: { mode: "none" as const },
      listen: { bind: "127.0.0.1", port: 8787 },
      mode: "managed" as const,
      store: { kind: "memory" as const }
    },
    teamSource: "/fixture/Spawnfile"
  }]
} satisfies NonNullable<EntrypointOptions["moltnet"]>;
