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
  modelAuthMethods: {},
  modelSecretsRequired: [],
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
      "RUN if ! id -u spawnfile >/dev/null 2>&1; then useradd --create-home --home-dir /home/spawnfile --shell /bin/bash spawnfile; fi"
    );
    expect(dockerfile).toContain(
      "RUN apt-get update && apt-get install -y --no-install-recommends curl openssl tar && rm -rf /var/lib/apt/lists/*"
    );
    expect(dockerfile).toContain("RUN npm install -g openclaw@2026.3.13");
    expect(dockerfile).toContain("RUN curl -fsSL https://example.com/picoclaw.tar.gz | tar -xz");
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("https://deb.nodesource.com/node_24.x");
    expect(dockerfile).not.toContain("RUN corepack enable");
    expect(dockerfile).toContain(
      "RUN mkdir -p /var/lib/spawnfile && chown -R spawnfile:spawnfile /var/lib/spawnfile /opt/spawnfile"
    );
    expect(dockerfile).toContain("USER spawnfile");
    expect(dockerfile).toContain("EXPOSE 18789 18790");
  });
});

describe("renderEntrypoint", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../runtime/index.js");
  });

  it("skips optional env-backed file writes when the env var is absent", async () => {
    const { renderEntrypoint } = await loadRenderModule({
      picoclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "picoclaw",
        runtimeRoot: "/opt/runtime/picoclaw"
      }
    });

    const entrypoint = renderEntrypoint(
      [
        createRuntimePlan("picoclaw", {
          envFiles: [
            {
              envName: "OPENAI_API_KEY",
              filePath: "/var/lib/spawnfile/picoclaw/secrets/OPENAI_API_KEY"
            }
          ],
          meta: {
            configFileName: "config.json",
            configPathEnv: "PICOCLAW_CONFIG",
            homeEnv: "PICOCLAW_HOME",
            instancePaths: {
              configPathTemplate: "<instance-root>/config.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "debian:bookworm-slim",
            startCommand: ["picoclaw", "gateway"],
            systemDeps: []
          }
        })
      ],
      []
    );

    expect(entrypoint).toContain('if [ -z "${!name:-}" ]; then');
    expect(entrypoint).toContain('printf %s "${!name:-}" > "$target"');
  });

  it("replaces every runtime-root placeholder inside a start-command token", async () => {
    const { renderEntrypoint } = await loadRenderModule({
      tinyclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "tinyclaw",
        runtimeRoot: "/opt/runtime/tinyclaw"
      }
    });

    const entrypoint = renderEntrypoint(
      [
        createRuntimePlan("tinyclaw", {
          meta: {
            configFileName: "settings.json",
            homeEnv: "TINYAGI_HOME",
            instancePaths: {
              configPathTemplate: "<instance-root>/settings.json",
              homePathTemplate: "<instance-root>/tinyagi",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:22-bookworm-slim",
            startCommand: [
              "bash",
              "-lc",
              "node <runtime-root>/main.js && node <runtime-root>/discord.js"
            ],
            systemDeps: []
          }
        })
      ],
      []
    );

    expect(entrypoint).not.toContain("<runtime-root>");
    expect(entrypoint).toContain("/opt/runtime/tinyclaw/main.js");
    expect(entrypoint).toContain("/opt/runtime/tinyclaw/discord.js");
  });
});

describe("createRootfsFiles", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../runtime/index.js");
  });

  it("maps home-scoped files into the runtime home path", async () => {
    const { createRootfsFiles } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/opt/runtime/openclaw"
      }
    });

    const files = createRootfsFiles([
      createRuntimePlan("openclaw", {
        meta: {
          configFileName: "openclaw.json",
          instancePaths: {
            configPathTemplate: "<instance-root>/home/.openclaw/<config-file>",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/home/.openclaw/workspace"
          },
          standaloneBaseImage: "node:24-bookworm-slim",
          startCommand: ["openclaw"],
          systemDeps: []
        },
        targetFiles: [
          {
            content: "",
            path: "home/.openclaw/agents/main/sessions/.keep"
          }
        ]
      })
    ]);

    expect(files).toEqual([
      {
        content: "",
        path: "container/rootfs/var/lib/spawnfile/openclaw/home/.openclaw/agents/main/sessions/.keep"
      }
    ]);
  });
});
