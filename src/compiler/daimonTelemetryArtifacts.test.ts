import { describe, expect, it } from "vitest";

import type { RuntimeContainerMeta } from "../runtime/index.js";

import { createDaimonTelemetryArtifacts } from "./daimonTelemetryArtifacts.js";
import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";
import type { CompiledNodeArtifact, RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { CompilePlan, ResolvedAgentNode } from "./types.js";

const baseMeta: RuntimeContainerMeta = {
  configFileName: "pi-app.json",
  instancePaths: {
    configPathTemplate: "<instance-root>/pi/<config-file>",
    homePathTemplate: "<instance-root>/home",
    workspacePathTemplate: "<instance-root>/workspace"
  },
  standaloneBaseImage: "node:24-bookworm-slim",
  startCommand: ["node", "app.mjs"],
  systemDeps: []
};

const createPlan = (root = "/tmp/Spawnfile"): CompilePlan => ({
  edges: [],
  nodes: [],
  root,
  runtimes: {}
});

const createRuntimePlan = (
  overrides: Partial<RuntimeTargetPlan> & Pick<RuntimeTargetPlan, "id" | "runtimeName" | "sourceIds">
): RuntimeTargetPlan => ({
  envFiles: [],
  instancePaths: {
    configPath: `/var/lib/spawnfile/instances/${overrides.runtimeName}/${overrides.id}/pi/pi-app.json`,
    homePath: `/var/lib/spawnfile/instances/${overrides.runtimeName}/${overrides.id}/home`,
    instanceRoot: `/var/lib/spawnfile/instances/${overrides.runtimeName}/${overrides.id}`,
    workspacePath: `/var/lib/spawnfile/instances/${overrides.runtimeName}/${overrides.id}/workspace`
  },
  meta: baseMeta,
  modelAuthMethods: {},
  modelSecretsRequired: [],
  runtimeRoot: "/opt/spawnfile/runtime-installs/pi",
  targetFiles: [],
  ...overrides
});

const createAgentNode = (id: string, slug: string): CompiledNodeArtifact => ({
  emittedFiles: [],
  id,
  kind: "agent",
  runtimeName: "pi",
  slug,
  value: { kind: "agent" } as unknown as ResolvedAgentNode
});

describe("createDaimonTelemetryArtifacts", () => {
  it("mounts a run-scoped telemetry volume per pi agent, keyed by node id on the instance", () => {
    const plan = createPlan();
    const runtimePlan = createRuntimePlan({
      id: "pi-app",
      runtimeName: "pi",
      sourceIds: ["agent:eleanor", "agent:sam"]
    });
    const compiledNodes = [createAgentNode("agent:eleanor", "eleanor"), createAgentNode("agent:sam", "sam")];

    const bundle = createDaimonTelemetryArtifacts(plan, [runtimePlan], compiledNodes);

    expect(bundle.mounts).toEqual([
      {
        id: "agent-eleanor-daimon-telemetry",
        mount_path: "/var/lib/spawnfile/instances/pi/pi-app/runtime/agents/eleanor/telemetry",
        reason: "daimon turn/wake causal telemetry for eleanor",
        volume_name: createPersistentVolumeName(plan.root, "agent-eleanor-daimon-telemetry")
      },
      {
        id: "agent-sam-daimon-telemetry",
        mount_path: "/var/lib/spawnfile/instances/pi/pi-app/runtime/agents/sam/telemetry",
        reason: "daimon turn/wake causal telemetry for sam",
        volume_name: createPersistentVolumeName(plan.root, "agent-sam-daimon-telemetry")
      }
    ]);
    expect(bundle.telemetryMountIdsByInstance.get("pi-app")).toEqual({
      "agent:eleanor": "agent-eleanor-daimon-telemetry",
      "agent:sam": "agent-sam-daimon-telemetry"
    });
  });

  it("does not attach generated-Pi telemetry to a public Daimon host", () => {
    const plan = createPlan();
    const runtimePlan = createRuntimePlan({
      id: "pi-app",
      runtimeName: "daimon",
      sourceIds: ["agent:mapper"]
    });
    const compiledNodes = [{ ...createAgentNode("agent:mapper", "mapper"), runtimeName: "daimon" }];

    const bundle = createDaimonTelemetryArtifacts(plan, [runtimePlan], compiledNodes);

    expect(bundle.mounts).toEqual([]);
    expect(bundle.telemetryMountIdsByInstance.size).toBe(0);
  });

  it("scopes the volume name to the run id, so two runs of the same project never share telemetry", () => {
    const plan = createPlan();
    const runtimePlan = createRuntimePlan({
      id: "pi-app",
      runtimeName: "pi",
      sourceIds: ["agent:eleanor"]
    });
    const compiledNodes = [createAgentNode("agent:eleanor", "eleanor")];

    const previousRunId = process.env.NOOPOLIS_RUN_ID;
    try {
      process.env.NOOPOLIS_RUN_ID = "run-abc";
      const runA = createDaimonTelemetryArtifacts(plan, [runtimePlan], compiledNodes);
      process.env.NOOPOLIS_RUN_ID = "run-def";
      const runB = createDaimonTelemetryArtifacts(plan, [runtimePlan], compiledNodes);

      expect(runA.mounts[0]!.volume_name).not.toEqual(runB.mounts[0]!.volume_name);
    } finally {
      if (previousRunId === undefined) {
        delete process.env.NOOPOLIS_RUN_ID;
      } else {
        process.env.NOOPOLIS_RUN_ID = previousRunId;
      }
    }
  });

  it("ignores non-pi/daimon runtime instances entirely", () => {
    const plan = createPlan();
    const runtimePlan = createRuntimePlan({
      id: "openclaw-assistant",
      runtimeName: "openclaw",
      sourceIds: ["agent:assistant"]
    });
    const compiledNodes = [{ ...createAgentNode("agent:assistant", "assistant"), runtimeName: "openclaw" }];

    const bundle = createDaimonTelemetryArtifacts(plan, [runtimePlan], compiledNodes);

    expect(bundle.mounts).toEqual([]);
    expect(bundle.telemetryMountIdsByInstance.size).toBe(0);
  });

  it("skips a pi instance with no home_path (never gets a mount)", () => {
    const plan = createPlan();
    const runtimePlan = createRuntimePlan({
      id: "pi-app",
      instancePaths: {
        configPath: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
        workspacePath: "/var/lib/spawnfile/instances/pi/pi-app/workspace"
      },
      runtimeName: "pi",
      sourceIds: ["agent:eleanor"]
    });
    const compiledNodes = [createAgentNode("agent:eleanor", "eleanor")];

    const bundle = createDaimonTelemetryArtifacts(plan, [runtimePlan], compiledNodes);

    expect(bundle.mounts).toEqual([]);
    expect(bundle.telemetryMountIdsByInstance.size).toBe(0);
  });

  it("skips a source id with no matching compiled agent node (defensive, should not happen in practice)", () => {
    const plan = createPlan();
    const runtimePlan = createRuntimePlan({
      id: "pi-app",
      runtimeName: "pi",
      sourceIds: ["agent:ghost"]
    });

    const bundle = createDaimonTelemetryArtifacts(plan, [runtimePlan], []);

    expect(bundle.mounts).toEqual([]);
    expect(bundle.telemetryMountIdsByInstance.size).toBe(0);
  });
});
