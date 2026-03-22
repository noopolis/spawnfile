import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";

const loadRenderModule = async (
  recipeByRuntime: Record<
    string,
    {
      commands: string[];
      copyCommands: string[];
      runtimeName: string;
      runtimeRoot: string;
    }
  >
) => {
  vi.doMock("../runtime/index.js", () => ({
    createRuntimeInstallRecipe: vi.fn(async (runtimeName: string) => {
      const recipe = recipeByRuntime[runtimeName];
      if (!recipe) {
        throw new Error(`Unexpected runtime install lookup: ${runtimeName}`);
      }

      return recipe;
    })
  }));

  return import("./containerArtifactsRender.js");
};

const createRuntimePlan = (
  runtimeName: string,
  overrides: Partial<RuntimeTargetPlan> = {}
): RuntimeTargetPlan => ({
  envFiles: [],
  id: `${runtimeName}-target`,
  instancePaths: {
    configPath: `/var/lib/spawnfile/${runtimeName}/config.json`,
    homePath: `/var/lib/spawnfile/${runtimeName}/home`,
    workspacePath: `/var/lib/spawnfile/${runtimeName}/workspace`
  },
  meta: {
    configFileName: "config.json",
    instancePaths: {
      configPathTemplate: "<instance-root>/config.json",
      homePathTemplate: "<instance-root>/home",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: "debian:bookworm-slim",
    startCommand: ["runtime"],
    systemDeps: []
  },
  runtimeName,
  runtimeRoot: `/opt/runtime/${runtimeName}`,
  targetFiles: [],
  ...overrides
});

describe("renderDockerfile", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../runtime/index.js");
  });

  it("uses the highest node base image when a multi-runtime image includes node runtimes", async () => {
    const { renderDockerfile } = await loadRenderModule({
      openclaw: {
        commands: ["npm install -g openclaw@2026.3.13"],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/usr/local/lib/node_modules/openclaw"
      },
      picoclaw: {
        commands: ["curl -fsSL https://example.com/picoclaw.tar.gz | tar -xz"],
        copyCommands: [],
        runtimeName: "picoclaw",
        runtimeRoot: "/opt/runtime/picoclaw"
      }
    });

    const dockerfile = await renderDockerfile([
      createRuntimePlan("openclaw", {
        meta: {
          configFileName: "openclaw.json",
          instancePaths: {
            configPathTemplate: "<instance-root>/openclaw.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          port: 18789,
          standaloneBaseImage: "node:24-bookworm-slim",
          startCommand: ["node", "<runtime-root>/openclaw.mjs"],
          systemDeps: ["curl", "openssl"]
        },
        port: 18789
      }),
      createRuntimePlan("picoclaw", {
        meta: {
          configFileName: "config.json",
          instancePaths: {
            configPathTemplate: "<instance-root>/config.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          port: 18790,
          standaloneBaseImage: "debian:bookworm-slim",
          startCommand: ["picoclaw", "gateway"],
          systemDeps: ["tar"]
        },
        port: 18790
      })
    ]);

    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain(
      "RUN apt-get update && apt-get install -y --no-install-recommends curl openssl tar && rm -rf /var/lib/apt/lists/*"
    );
    expect(dockerfile).toContain("RUN npm install -g openclaw@2026.3.13");
    expect(dockerfile).toContain("RUN curl -fsSL https://example.com/picoclaw.tar.gz | tar -xz");
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("https://deb.nodesource.com/node_24.x");
    expect(dockerfile).not.toContain("RUN corepack enable");
    expect(dockerfile).toContain("EXPOSE 18789 18790");
  });
});
