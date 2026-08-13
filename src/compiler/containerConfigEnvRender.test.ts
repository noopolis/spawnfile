import { describe, expect, it } from "vitest";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  createConfigEnvMaterializationFunction,
  createConfigEnvWrites
} from "./containerConfigEnvRender.js";

const plan = (configEnvBindings: RuntimeTargetPlan["configEnvBindings"]): RuntimeTargetPlan => ({
  configEnvBindings,
  envFiles: [],
  id: "agent-a",
  instancePaths: {
    configPath: "/runtime/config.json",
    homePath: "/runtime/home",
    workspacePath: "/runtime/workspace"
  },
  meta: {
    configFileName: "config.json",
    configPathEnv: "CONFIG_PATH",
    homeEnv: "HOME",
    instancePaths: {
      configPathTemplate: "<instance-root>/config.json",
      homePathTemplate: "<instance-root>/home",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    startCommand: ["runtime"],
    standaloneBaseImage: "debian:bookworm-slim",
    systemDeps: []
  },
  modelAuthMethods: {},
  modelSecretsRequired: [],
  recipeEnv: {},
  runtimeName: "test",
  runtimeRoot: "/runtime",
  sourceIds: [],
  targetFiles: []
});

describe("container config-env rendering", () => {
  it("renders legacy and structured paths with optional transforms", () => {
    expect(createConfigEnvWrites(plan([
      { envName: "LEGACY_TOKEN", jsonPath: "headers.token" },
      {
        envName: "BEARER_TOKEN",
        jsonPath: ["tools", "mcp", "servers", "a.b", "headers", "Authorization"],
        transform: "bearer"
      }
    ]))).toEqual([
      "apply_json_env_value '/runtime/config.json' 'LEGACY_TOKEN' 'headers.token'",
      "apply_json_env_value '/runtime/config.json' 'BEARER_TOKEN' '[\"tools\",\"mcp\",\"servers\",\"a.b\",\"headers\",\"Authorization\"]' 'bearer'"
    ]);
  });

  it("owns the generated JSON materialization function and transform rejection", () => {
    const rendered = createConfigEnvMaterializationFunction().join("\n");
    expect(rendered).toContain("json.loads(json_path_arg)");
    expect(rendered).toContain("value = f'Bearer {value}'");
    expect(rendered).toContain("Unsupported config env transform");
  });
});
