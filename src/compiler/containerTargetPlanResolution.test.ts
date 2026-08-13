import { describe, expect, it } from "vitest";

import type {
  ContainerTarget,
  ContainerTargetInput,
  RuntimeContainerMeta
} from "../runtime/index.js";

import type { ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import {
  assertTargetHasConfig,
  createDefaultTargets,
  resolveInstancePaths,
  resolveTargetConfigEnvBindings,
  resolveTargetEnvFiles,
  resolveTargetExposure,
  resolveTargetModelAuthMethods,
  resolveTargetModelSecrets,
  resolveTargetPackages
} from "./containerTargetPlanResolution.js";

const createAgent = (
  name: string,
  overrides: Partial<ResolvedAgentNode> = {}
): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name,
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "test", options: {} },
  secrets: [],
  skills: [],
  source: `/tmp/${name}/Spawnfile`,
  subagents: [],
  ...overrides
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

const createInput = (
  id: string,
  value: ResolvedAgentNode | ResolvedTeamNode,
  emittedFiles: ContainerTargetInput["emittedFiles"] = []
): ContainerTargetInput => ({
  emittedFiles,
  id,
  kind: value.kind,
  slug: id.split(":").at(-1) ?? id,
  value
});

const createMeta = (
  overrides: Partial<RuntimeContainerMeta> = {}
): RuntimeContainerMeta => ({
  configFileName: "config.json",
  instancePaths: {
    configPathTemplate: "<instance-root>/home/<config-file>",
    workspacePathTemplate: "<instance-root>/workspace/<config-file>"
  },
  standaloneBaseImage: "node:22",
  startCommand: ["node", "app.js"],
  systemDeps: [],
  ...overrides
});

const createTarget = (overrides: Partial<ContainerTarget> = {}): ContainerTarget => ({
  files: [],
  id: "combined",
  ...overrides
});

describe("container target plan resolution", () => {
  it("creates default targets and resolves target-local paths and bindings", () => {
    const emittedFiles = [{ content: "{}\n", path: "config.json" }];
    expect(createDefaultTargets([
      createInput("agent:one", createAgent("one"), emittedFiles)
    ])).toEqual([{
      files: emittedFiles,
      id: "agent-one",
      sourceIds: ["agent:one"]
    }]);

    expect(resolveTargetEnvFiles(
      "/runtime/instance/config.json",
      createTarget({ envFiles: [{ envName: "AUTH_FILE", relativePath: "auth/token" }] })
    )).toEqual([{ envName: "AUTH_FILE", filePath: "/runtime/instance/auth/token" }]);
    expect(resolveTargetEnvFiles("/runtime/config.json", createTarget())).toEqual([]);

    const inherited = { envName: "BASE_TOKEN", jsonPath: "base.token" };
    const local = { envName: "LOCAL_TOKEN", generated: true, jsonPath: ["local", "token"] } as const;
    expect(resolveTargetConfigEnvBindings(
      createMeta({ configEnvBindings: [inherited] }),
      createTarget({ configEnvBindings: [local] })
    )).toEqual([inherited, local]);
    expect(resolveTargetConfigEnvBindings(createMeta(), createTarget())).toEqual([]);
  });

  it("requires the runtime config and expands every instance path template", () => {
    const meta = createMeta({
      instancePaths: {
        configPathTemplate: "<instance-root>/home/<config-file>",
        homePathTemplate: "<instance-root>/home",
        workspacePathTemplate: "<instance-root>/workspace/<config-file>"
      }
    });
    expect(() => assertTargetHasConfig(
      "test",
      "combined",
      meta,
      [{ content: "{}", path: "config.json" }]
    )).not.toThrow();
    expect(() => assertTargetHasConfig("test", "combined", meta, [])).toThrow(
      /Container target combined for test is missing config\.json/
    );
    expect(resolveInstancePaths("test", "combined", meta)).toEqual({
      configPath: "/var/lib/spawnfile/instances/test/combined/home/config.json",
      homePath: "/var/lib/spawnfile/instances/test/combined/home",
      instanceRoot: "/var/lib/spawnfile/instances/test/combined",
      workspacePath: "/var/lib/spawnfile/instances/test/combined/workspace/config.json"
    });
    expect(resolveInstancePaths("test", "headless", createMeta()).homePath).toBeUndefined();
  });

  it("deduplicates exact packages, sorts them, and rejects conflicting definitions", () => {
    const npmOne = { id: "npm:one", manager: "npm", name: "one", version: "1.0.0" };
    const pipTwo = { id: "pip:two", manager: "pip", name: "two", scope: "runtime" };
    const inputs = [
      createInput("team:group", createTeam()),
      createInput("agent:unselected", createAgent("unselected", { packages: [npmOne] })),
      createInput("agent:one", createAgent("one", { packages: [pipTwo, npmOne] })),
      createInput("agent:two", createAgent("two", { packages: [{ ...npmOne, id: "duplicate-id" }] }))
    ];
    expect(resolveTargetPackages(createTarget(), inputs)).toEqual([]);
    expect(resolveTargetPackages(
      createTarget({ sourceIds: ["team:group", "agent:one", "agent:two"] }),
      inputs
    )).toEqual([npmOne, pipTwo]);

    const conflicting = createInput("agent:conflict", createAgent("conflict", {
      packages: [{ ...npmOne, id: "npm:one-v2", version: "2.0.0" }]
    }));
    expect(() => resolveTargetPackages(
      createTarget({ sourceIds: ["agent:one", "agent:conflict"] }),
      [...inputs, conflicting]
    )).toThrow(/conflicting package definitions for npm package one/);
  });

  it("collects selected model secrets and auth methods and rejects auth conflicts", () => {
    const createExecution = (method: "api_key" | "codex", key?: string) => ({
      model: {
        primary: {
          auth: { ...(key ? { key } : {}), method },
          name: "gpt-test",
          provider: "openai"
        }
      },
      sandbox: { mode: "workspace" as const }
    });
    const inputs = [
      createInput("team:group", createTeam()),
      createInput("agent:unselected", createAgent("unselected", {
        execution: createExecution("api_key", "IGNORED_KEY")
      })),
      createInput("agent:zeta", createAgent("zeta", {
        execution: createExecution("api_key", "ZETA_KEY")
      })),
      createInput("agent:alpha", createAgent("alpha", {
        execution: createExecution("api_key", "ALPHA_KEY")
      }))
    ];
    expect(resolveTargetModelSecrets(createTarget(), inputs)).toEqual([]);
    expect(resolveTargetModelAuthMethods(createTarget(), inputs)).toEqual({});
    const selected = createTarget({ sourceIds: ["team:group", "agent:zeta", "agent:alpha"] });
    expect(resolveTargetModelSecrets(selected, inputs)).toEqual(["ALPHA_KEY", "ZETA_KEY"]);
    expect(resolveTargetModelAuthMethods(selected, inputs)).toEqual({ openai: "api_key" });

    const conflicting = createInput("agent:codex", createAgent("codex", {
      execution: createExecution("codex")
    }));
    expect(() => resolveTargetModelAuthMethods(
      createTarget({ sourceIds: ["agent:zeta", "agent:codex"] }),
      [...inputs, conflicting]
    )).toThrow(/conflicting auth methods for provider openai/);
  });

  it("publishes a port only when a selected agent explicitly opts in", () => {
    const inputs = [
      createInput("team:group", createTeam()),
      createInput("agent:hidden", createAgent("hidden")),
      createInput("agent:public", createAgent("public", { expose: true }))
    ];
    expect(resolveTargetExposure(createTarget(), inputs)).toBe(false);
    expect(resolveTargetExposure(
      createTarget({ sourceIds: ["team:group", "agent:hidden"] }),
      inputs
    )).toBe(false);
    expect(resolveTargetExposure(
      createTarget({ sourceIds: ["agent:unselected", "agent:public"] }),
      inputs
    )).toBe(true);
  });
});
