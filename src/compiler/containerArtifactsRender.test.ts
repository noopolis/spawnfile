import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { createStateOwnershipCommand } from "./containerStateOwnershipRender.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

const loadRenderModule = async (
  recipeByRuntime: Record<
    string,
    {
      baseImage?: string;
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
  publishedPort: overrides.publishedPort ?? overrides.port,
  runtimeName,
  runtimeRoot: `/opt/runtime/${runtimeName}`,
  targetFiles: [],
  ...overrides
});

const writeExecutableEntrypoint = async (
  directory: string,
  content: string
): Promise<string> => {
  const entrypointPath = path.join(directory, "entrypoint.sh");
  await writeFile(entrypointPath, content);
  await chmod(entrypointPath, 0o755);
  return entrypointPath;
};

const createResourceRuntimePlan = (
  directory: string,
  startCommand: string,
  resources: RuntimeTargetPlan["resources"]
): RuntimeTargetPlan => ({
  ...createRuntimePlan("test-runtime", {
    instancePaths: {
      configPath: path.join(directory, "runtime", "config.json"),
      homePath: path.join(directory, "runtime", "home"),
      workspacePath: path.join(directory, "runtime", "workspace")
    },
    meta: {
      configFileName: "config.json",
      instancePaths: {
        configPathTemplate: "<instance-root>/config.json",
        homePathTemplate: "<instance-root>/home",
        workspacePathTemplate: "<instance-root>/workspace"
      },
      standaloneBaseImage: "debian:bookworm-slim",
      startCommand: ["sh", "-c", startCommand],
      systemDeps: []
    },
    resources
  })
});

describe("renderDockerfile", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../runtime/index.js");
  });

  it("installs declared Daimon AGY realm packages on a prebuilt base image", async () => {
    const { renderDockerfile } = await loadRenderModule({
      daimon: {
        baseImage: "noopolis/spawnfile-runtime-daimon:test",
        commands: [],
        copyCommands: [],
        runtimeName: "daimon",
        runtimeRoot: "/opt/runtime/daimon"
      }
    });
    const plan = createRuntimePlan("daimon", {
      meta: {
        ...createRuntimePlan("daimon").meta,
        systemDeps: ["bash", "bubblewrap", "ca-certificates", "curl", "dbus-daemon", "gnome-keyring", "util-linux"]
      }
    });
    const dockerfile = await renderDockerfile([plan], {
      persistentMountPaths: ["/var/lib/spawnfile/daimon/agy-subscription-realm"]
    });
    expect(dockerfile).toContain("FROM noopolis/spawnfile-runtime-daimon:test");
    expect(dockerfile).toContain(
      "apt-get install -y --no-install-recommends bubblewrap dbus-daemon gnome-keyring util-linux"
    );
    expect(dockerfile).not.toContain(
      "apt-get install -y --no-install-recommends bash ca-certificates curl"
    );
    expect(dockerfile).not.toContain("secret-tool");
    expect(dockerfile).not.toContain("dbus-x11");
    expect(dockerfile).toContain("HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12");
    expect(dockerfile).toContain("/healthz");
    expect(dockerfile).toContain(plan.instancePaths.configPath);
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
          port: 18990,
          standaloneBaseImage: "debian:bookworm-slim",
          startCommand: ["picoclaw", "gateway"],
          systemDeps: ["tar"]
        },
        port: 18990
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
      "RUN mkdir -p '/var/lib/spawnfile' && chown -R spawnfile:spawnfile '/var/lib/spawnfile'"
    );
    expect(dockerfile).toContain("USER spawnfile");
    expect(dockerfile).toContain("EXPOSE 18789 18990");
  });

  it("installs apt, npm, and pipx packages from effective environment packages", async () => {
    const { renderDockerfile } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/usr/local/lib/node_modules/openclaw"
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
          standaloneBaseImage: "debian:bookworm-slim",
          startCommand: ["node", "<runtime-root>/openclaw.mjs"],
          systemDeps: []
        },
        packages: [
          {
            id: "apt-jq",
            manager: "apt",
            name: "jq",
            version: "1.7.1"
          },
          {
            id: "apt-jq-dup",
            manager: "apt",
            name: "jq",
            version: "1.7.1"
          },
          {
            id: "npm-openapi",
            manager: "npm",
            name: "openapi-typescript",
            version: "6.7.4"
          },
          {
            id: "npm-pip",
            manager: "npm",
            name: "npm"
          },
          {
            id: "pipx-req",
            manager: "pipx",
            name: "cowsay",
            version: "0.4.0"
          }
        ],
        port: 18789
      })
    ]);

    expect(dockerfile).toContain(
      "RUN apt-get update && apt-get install -y --no-install-recommends jq=1.7.1 pipx && rm -rf /var/lib/apt/lists/*"
    );
    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit npm openapi-typescript@6.7.4"
    );
    expect(dockerfile).toContain("RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install cowsay==0.4.0");
  });

  it("lets explicit npm packages override runtime global npm defaults", async () => {
    const { renderDockerfile } = await loadRenderModule({
      picoclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "picoclaw",
        runtimeRoot: "/opt/spawnfile/runtime-installs/picoclaw"
      }
    });

    const dockerfile = await renderDockerfile([
      createRuntimePlan("picoclaw", {
        meta: {
          configFileName: "config.json",
          globalNpmPackages: ["@openai/codex", "typescript"],
          instancePaths: {
            configPathTemplate: "<instance-root>/config.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          standaloneBaseImage: "debian:bookworm-slim",
          startCommand: ["picoclaw", "run"],
          systemDeps: []
        },
        packages: [
          {
            id: "codex",
            manager: "npm",
            name: "@openai/codex",
            version: "0.128.0"
          }
        ]
      })
    ]);

    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit @openai/codex@0.128.0 typescript"
    );
    expect(dockerfile).not.toContain("@openai/codex ");
  });

  it("installs python3 when generated entrypoints need JSON config env writes", async () => {
    const { renderDockerfile } = await loadRenderModule({
      openclaw: {
        commands: ["npm install -g openclaw@2026.3.13"],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/usr/local/lib/node_modules/openclaw"
      }
    });

    const dockerfile = await renderDockerfile([
      createRuntimePlan("openclaw", {
        configEnvBindings: [
          {
            envName: "SLACK_BOT_TOKEN",
            jsonPath: "channels.slack.botToken"
          }
        ],
        meta: {
          configFileName: "openclaw.json",
          configPathEnv: "OPENCLAW_CONFIG_PATH",
          homeEnv: "OPENCLAW_HOME",
          instancePaths: {
            configPathTemplate: "<instance-root>/openclaw.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          standaloneBaseImage: "node:24-bookworm-slim",
          startCommand: ["node", "<runtime-root>/openclaw.mjs"],
          systemDeps: ["openssl"]
        }
      })
    ]);

    expect(dockerfile).toContain(
      "RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 && rm -rf /var/lib/apt/lists/*"
    );
  });

  it("installs python3 when Moltnet node endpoints can be rebound at runtime", async () => {
    const { renderDockerfile } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/usr/local/lib/node_modules/openclaw"
      }
    });

    const dockerfile = await renderDockerfile(
      [createRuntimePlan("openclaw")],
      {
        hasMoltnet: true,
        hasStagedMoltnetBinaries: true,
        moltnet: {
          nodePlans: [{
            configPath: "/var/lib/spawnfile/moltnet/nodes/agent.json",
            networkId: "pitch"
          }],
          serverPlans: []
        }
      }
    );

    expect(dockerfile).toContain("python3");
  });

  it("rejects Moltnet without a pinned stamped release instead of installing latest", async () => {
    const { renderDockerfile } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/usr/local/lib/node_modules/openclaw"
      }
    });

    await expect(renderDockerfile(
      [
        createRuntimePlan("openclaw", {
          meta: {
            configFileName: "openclaw.json",
            instancePaths: {
              configPathTemplate: "<instance-root>/openclaw.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:24-bookworm-slim",
            startCommand: ["node", "<runtime-root>/openclaw.mjs"],
            systemDeps: []
          }
        })
      ],
      { hasMoltnet: true }
    )).rejects.toThrow(/unpinned latest installation is disabled/u);
  });

  it("installs staged moltnet binaries when a local release is configured", async () => {
    const { renderDockerfile } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/usr/local/lib/node_modules/openclaw"
      }
    });

    const dockerfile = await renderDockerfile(
      [
        createRuntimePlan("openclaw", {
          meta: {
            configFileName: "openclaw.json",
            instancePaths: {
              configPathTemplate: "<instance-root>/openclaw.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:24-bookworm-slim",
            startCommand: ["node", "<runtime-root>/openclaw.mjs"],
            systemDeps: []
          }
        })
      ],
      { hasMoltnet: true, hasStagedMoltnetBinaries: true }
    );

    expect(dockerfile).toContain("COPY moltnet-bin/ /usr/local/bin/");
    expect(dockerfile).toContain("RUN chmod +x /usr/local/bin/moltnet");
    expect(dockerfile).not.toContain("https://moltnet.dev/install.sh");
    expect(dockerfile).not.toContain("ca-certificates curl tar");
  });

  it("renders runtime post-rootfs commands after copying generated files", async () => {
    const { renderDockerfile } = await loadRenderModule({
      pi: {
        commands: ["mkdir -p /opt/runtime/pi"],
        copyCommands: [],
        runtimeName: "pi",
        runtimeRoot: "/opt/runtime/pi"
      }
    });

    const dockerfile = await renderDockerfile([
      createRuntimePlan("pi", {
        meta: {
          configFileName: "pi-app.json",
          instancePaths: {
            configPathTemplate: "<instance-root>/pi-app.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          postRootfsCommands: ["cd /opt/runtime/pi && npm install --omit=dev"],
          standaloneBaseImage: "node:24-bookworm-slim",
          startCommand: ["node", "<runtime-root>/app.mjs"],
          systemDeps: []
        }
      })
    ]);

    expect(dockerfile.indexOf("COPY container/rootfs/ /")).toBeLessThan(
      dockerfile.indexOf("RUN cd /opt/runtime/pi && npm install --omit=dev")
    );
  });

  it("uses prebuilt runtime base images without reinstalling provided runtime deps", async () => {
    const { renderDockerfile } = await loadRenderModule({
      pi: {
        baseImage: "noopolis/spawnfile-pi-runtime:test",
        commands: ["mkdir -p /opt/runtime/pi"],
        copyCommands: [],
        runtimeName: "pi",
        runtimeRoot: "/opt/runtime/pi"
      }
    });

    const dockerfile = await renderDockerfile([
      createRuntimePlan("pi", {
        meta: {
          configFileName: "pi-app.json",
          instancePaths: {
            configPathTemplate: "<instance-root>/pi-app.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          standaloneBaseImage: "node:24-bookworm-slim",
          startCommand: ["node", "<runtime-root>/app.mjs"],
          systemDeps: ["bash", "curl", "git"]
        }
      })
    ]);

    expect(dockerfile).toContain("FROM noopolis/spawnfile-pi-runtime:test");
    expect(dockerfile).toContain("RUN mkdir -p /opt/runtime/pi");
    expect(dockerfile).not.toContain("apt-get install -y --no-install-recommends bash curl git");
    expect(dockerfile).not.toContain("npm install --omit=dev --no-fund --no-audit @earendil-works/pi-coding-agent");
  });

  it("copies runtime artifact images into mixed-runtime builds", async () => {
    const { renderDockerfile } = await loadRenderModule({
      daimon: {
        commands: [],
        copyCommands: [
          "COPY --from=noopolis/spawnfile-runtime-daimon@sha256:19b671e589ad8c9e8f1b55610ccbf86ee72f16b4cb2f707ec419f5ef0d6942aa /opt/spawnfile/runtime-installs/daimon /opt/spawnfile/runtime-installs/daimon"
        ],
        runtimeName: "daimon",
        runtimeRoot: "/opt/spawnfile/runtime-installs/daimon"
      },
      openclaw: {
        commands: [],
        copyCommands: [
          "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.11 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
        ],
        runtimeName: "openclaw",
        runtimeRoot: "/opt/spawnfile/runtime-installs/openclaw"
      }
    });

    const dockerfile = await renderDockerfile([
      createRuntimePlan("daimon", {
        meta: {
          configFileName: "pi-app.json",
          instancePaths: {
            configPathTemplate: "<instance-root>/pi-app.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          standaloneBaseImage: "node:22-bookworm-slim",
          startCommand: ["node", "<runtime-root>/app.mjs"],
          systemDeps: ["bash", "git"]
        }
      }),
      createRuntimePlan("openclaw", {
        meta: {
          configFileName: "openclaw.json",
          instancePaths: {
            configPathTemplate: "<instance-root>/openclaw.json",
            homePathTemplate: "<instance-root>/home",
            workspacePathTemplate: "<instance-root>/workspace"
          },
          standaloneBaseImage: "node:24-bookworm-slim",
          startCommand: ["node", "<runtime-root>/openclaw.mjs"],
          systemDeps: ["curl"]
        }
      })
    ]);

    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-daimon@sha256:19b671e589ad8c9e8f1b55610ccbf86ee72f16b4cb2f707ec419f5ef0d6942aa /opt/spawnfile/runtime-installs/daimon /opt/spawnfile/runtime-installs/daimon"
    );
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.11 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
    );
    expect(dockerfile).not.toContain("npm install --omit=dev --no-fund --no-audit @noopolis/daimon");
    expect(dockerfile.indexOf("COPY --from=noopolis/spawnfile-runtime-daimon")).toBeLessThan(
      dockerfile.indexOf("COPY container/rootfs/ /")
    );
    expect(dockerfile.indexOf("COPY --from=noopolis/spawnfile-runtime-openclaw")).toBeLessThan(
      dockerfile.indexOf("COPY container/rootfs/ /")
    );
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

  it("renders recipeEnv into the exec-time env prefix, not the Dockerfile", async () => {
    const { renderEntrypoint } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/opt/runtime/openclaw"
      }
    });

    const entrypoint = renderEntrypoint(
      [
        createRuntimePlan("openclaw", {
          meta: {
            configFileName: "openclaw.json",
            instancePaths: {
              configPathTemplate: "<instance-root>/openclaw.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:24-bookworm-slim",
            startCommand: ["node", "<runtime-root>/openclaw.mjs"],
            systemDeps: []
          },
          recipeEnv: { NOOPOLIS_RUN_ID: "run-abc123" }
        })
      ],
      []
    );

    expect(entrypoint).toContain("NOOPOLIS_RUN_ID='run-abc123' exec");
  });

  it("emits no env assignment when recipeEnv is empty", async () => {
    const { renderEntrypoint } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/opt/runtime/openclaw"
      }
    });

    const entrypoint = renderEntrypoint(
      [
        createRuntimePlan("openclaw", {
          meta: {
            configFileName: "openclaw.json",
            instancePaths: {
              configPathTemplate: "<instance-root>/openclaw.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:24-bookworm-slim",
            startCommand: ["node", "<runtime-root>/openclaw.mjs"],
            systemDeps: []
          },
          recipeEnv: {}
        })
      ],
      []
    );

    expect(entrypoint).not.toContain("NOOPOLIS_RUN_ID");
  });

  it("replaces runtime start-command placeholders", async () => {
    const { renderEntrypoint } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/opt/runtime/openclaw"
      }
    });

    const entrypoint = renderEntrypoint(
      [
        createRuntimePlan("openclaw", {
          meta: {
            configFileName: "openclaw.json",
            homeEnv: "OPENCLAW_HOME",
            instancePaths: {
              configPathTemplate: "<instance-root>/openclaw.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:22-bookworm-slim",
            startCommand: [
              "bash",
              "-lc",
              "node <runtime-root>/openclaw.mjs --config <config-path> --home <home-path> --workspace <workspace-path>"
            ],
            systemDeps: []
          }
        })
      ],
      []
    );

    expect(entrypoint).not.toContain("<runtime-root>");
    expect(entrypoint).not.toContain("<config-path>");
    expect(entrypoint).not.toContain("<home-path>");
    expect(entrypoint).not.toContain("<workspace-path>");
    expect(entrypoint).toContain("/opt/runtime/openclaw/openclaw.mjs");
    expect(entrypoint).toContain("--config /var/lib/spawnfile/openclaw/config.json");
    expect(entrypoint).toContain("--home /var/lib/spawnfile/openclaw/home");
    expect(entrypoint).toContain("--workspace /var/lib/spawnfile/openclaw/workspace");
  });

  it("starts moltnet servers and nodes before waiting on child processes", async () => {
    const { renderEntrypoint } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/opt/runtime/openclaw"
      }
    });

    const entrypoint = renderEntrypoint(
      [
        createRuntimePlan("openclaw", {
          meta: {
            configFileName: "openclaw.json",
            instancePaths: {
              configPathTemplate: "<instance-root>/openclaw.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:24-bookworm-slim",
            startCommand: ["node", "<runtime-root>/openclaw.mjs"],
            systemDeps: []
          },
          port: 18789
        })
      ],
      [],
      {
        hasMoltnet: true,
        moltnet: {
          nodePlans: [
            {
              configPath: "/var/lib/spawnfile/moltnet/nodes/research.json",
              networkId: "local_lab"
            }
          ],
          serverPlans: [
            {
              baseUrl: "http://127.0.0.1:8787",
              configPath: "/var/lib/spawnfile/moltnet/servers/local_lab/Moltnet.json",
              id: "local_lab",
              mode: "managed",
              name: "Local Lab",
              networkId: "local_lab",
              port: 8787,
              rooms: [
                {
                  id: "research",
                  members: ["orchestrator", "researcher"]
                }
              ],
              server: {
                auth: { mode: "none" },
                listen: { bind: "127.0.0.1", port: 8787 },
                mode: "managed",
                store: { kind: "sqlite", path: "/var/lib/spawnfile/moltnet/networks/local_lab/moltnet.sqlite" }
              },
              secretPatches: [],
              teamSource: "/tmp/team/Spawnfile"
            }
          ]
        }
      }
    );

    expect(entrypoint).toContain("mkdir -p '/var/lib/spawnfile/moltnet/servers'");
    expect(entrypoint).toContain("mkdir -p '/var/lib/spawnfile/moltnet/networks/local_lab'");
    expect(entrypoint).toContain(
      "MOLTNET_CONFIG='/var/lib/spawnfile/moltnet/servers/local_lab/Moltnet.json'"
    );
    expect(entrypoint).toContain(
      "/usr/local/bin/moltnet start --config '/var/lib/spawnfile/moltnet/servers/local_lab/Moltnet.json' &"
    );
    expect(entrypoint).toContain("http://127.0.0.1:18789/healthz");
    expect(entrypoint).toContain("http://127.0.0.1:8787/healthz");
    expect(entrypoint).toContain("/usr/local/bin/moltnet node '/var/lib/spawnfile/moltnet/nodes/research.json' &");
    expect(entrypoint).toContain('export OPENCLAW_HOOKS_TOKEN="hooks-${OPENCLAW_GATEWAY_TOKEN}"');
  });

  it("starts moltnet servers and nodes in multi-runtime entrypoints", async () => {
    const { renderEntrypoint } = await loadRenderModule({
      openclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "openclaw",
        runtimeRoot: "/opt/runtime/openclaw"
      },
      picoclaw: {
        commands: [],
        copyCommands: [],
        runtimeName: "picoclaw",
        runtimeRoot: "/opt/runtime/picoclaw"
      }
    });

    const entrypoint = renderEntrypoint(
      [
        createRuntimePlan("openclaw", {
          meta: {
            configFileName: "openclaw.json",
            instancePaths: {
              configPathTemplate: "<instance-root>/openclaw.json",
              homePathTemplate: "<instance-root>/home",
              workspacePathTemplate: "<instance-root>/workspace"
            },
            standaloneBaseImage: "node:24-bookworm-slim",
            startCommand: ["node", "<runtime-root>/openclaw.mjs"],
            systemDeps: []
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
            standaloneBaseImage: "debian:bookworm-slim",
            startCommand: ["picoclaw", "gateway"],
            systemDeps: []
          }
        })
      ],
      [],
      {
        hasMoltnet: true,
        moltnet: {
          nodePlans: [
            {
              configPath: "/var/lib/spawnfile/moltnet/nodes/research.json",
              networkId: "local_lab"
            }
          ],
          serverPlans: [
            {
              baseUrl: "http://127.0.0.1:8787",
              configPath: "/var/lib/spawnfile/moltnet/servers/local_lab/Moltnet.json",
              id: "local_lab",
              mode: "managed",
              name: "Local Lab",
              networkId: "local_lab",
              port: 8787,
              rooms: [
                {
                  id: "research",
                  members: ["orchestrator"]
                }
              ],
              server: {
                auth: { mode: "none" },
                listen: { bind: "127.0.0.1", port: 8787 },
                mode: "managed",
                store: { kind: "memory" }
              },
              secretPatches: [],
              teamSource: "/tmp/team/Spawnfile"
            }
          ]
        }
      }
    );

    expect(entrypoint).not.toContain("surface-router.js");
    expect(entrypoint).not.toContain("router-config.json");
    expect(entrypoint).toContain(
      "MOLTNET_CONFIG='/var/lib/spawnfile/moltnet/servers/local_lab/Moltnet.json'"
    );
    expect(entrypoint).toContain(
      "/usr/local/bin/moltnet start --config '/var/lib/spawnfile/moltnet/servers/local_lab/Moltnet.json' &"
    );
    expect(entrypoint).toContain("http://127.0.0.1:18789/healthz");
    expect(entrypoint).toContain("picoclaw");
    expect(entrypoint).toContain("/usr/local/bin/moltnet node '/var/lib/spawnfile/moltnet/nodes/research.json' &");
  });

  it("prepares volume resources before starting the runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-volume-resource-"));
    temporaryDirectories.push(directory);
    const mountPath = path.join(directory, "resources", "cache");
    const backingPath = path.join(directory, "backing", "cache");
    const proofPath = path.join(mountPath, "proof.txt");
    const { renderEntrypoint } = await loadRenderModule({});
    const plan = createResourceRuntimePlan(
      directory,
      `test -d "${mountPath}" && printf volume-ok > "${proofPath}"`,
      [
        {
          id: "cache",
          kind: "volume",
          backingPath,
          linkPath: mountPath,
          mode: "mutable",
          mount: "./resources/cache",
          sharing: "per_agent",
          resolvedIdentity: "sha256:replacement-proof"
        } as any
      ]
    );
    await mkdir(path.dirname(plan.instancePaths.configPath), { recursive: true });
    await writeFile(plan.instancePaths.configPath, "{}\n");

    const entrypoint = await writeExecutableEntrypoint(
      directory,
      renderEntrypoint([plan], [])
    );
    await execFile("bash", [entrypoint], { cwd: directory });

    await expect(readFile(proofPath, "utf8")).resolves.toBe("volume-ok");
    await expect(lstat(mountPath).then((stats) => stats.isSymbolicLink())).resolves.toBe(true);
    await expect(readlink(mountPath)).resolves.toBe(backingPath);
    await expect(readFile(path.join(backingPath, ".spawnfile-resource-identity"), "utf8")).resolves.toBe("sha256:replacement-proof\n");
    await execFile("bash", [entrypoint], { cwd: directory });
    await writeFile(path.join(backingPath, ".spawnfile-resource-identity"), "wrong\n");
    await expect(execFile("bash", [entrypoint], { cwd: directory })).rejects.toThrow(/replacement sentinel mismatch/u);
    await rm(path.join(backingPath, ".spawnfile-resource-identity"));
    await expect(execFile("bash", [entrypoint], { cwd: directory })).rejects.toThrow(/nonempty without an authenticated replacement sentinel/u);
  });

  it("authenticates the compiler bootstrap marker copied into a fresh named volume", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-volume-bootstrap-image-"));
    temporaryDirectories.push(directory);
    const tag = `spawnfile-volume-bootstrap-${Date.now().toString(36)}`;
    const volume = `${tag}-volume`;
    const hostileVolumes = [`${tag}-wrong`, `${tag}-extra`, `${tag}-link`];
    const backingPath = "/var/lib/spawnfile/resources/edition-state";
    const plan: RuntimeTargetPlan = {
      ...createRuntimePlan("test-runtime"),
      runtimeName: "daimon",
      instancePaths: { configPath: "/runtime/config.json", workspacePath: "/runtime/workspace" },
      meta: { configFileName: "config.json", instancePaths: { configPathTemplate: "", workspacePathTemplate: "" }, standaloneBaseImage: "node:24-bookworm-slim", startCommand: ["sh", "-c", `test -f '${backingPath}/.spawnfile-resource-identity' && test ! -e '${backingPath}/.spawnfile-volume-init'`], systemDeps: [] },
      resources: [{ backingPath, id: "edition-state", kind: "volume", linkPath: "/runtime/workspace/edition-state", mode: "mutable", mount: "./edition-state", resolvedIdentity: `sha256:${"a".repeat(64)}`, sharing: "team" } as any]
    };
    const { renderEntrypoint } = await loadRenderModule({});
    await writeFile(path.join(directory, "entrypoint.sh"), renderEntrypoint([plan], []), { mode: 0o755 });
    await writeFile(path.join(directory, "Dockerfile"), [
      "FROM node:24-bookworm-slim",
      "RUN groupadd --gid 2000 spawnfile && useradd --uid 2000 --gid 2000 --create-home spawnfile",
      "COPY --chmod=755 entrypoint.sh /entrypoint.sh",
      "RUN mkdir -p /runtime/workspace /runtime && printf '{}\\n' > /runtime/config.json && chown -R 2000:2000 /runtime",
      `RUN ${createStateOwnershipCommand([plan], [backingPath])} && chown -R 2000:2000 '${backingPath}' /runtime`,
      "USER spawnfile",
      "ENTRYPOINT [\"/entrypoint.sh\",\"--spawnfile-runtime-identity\",\"2000\",\"2000\"]"
    ].join("\n"));
    try {
      await execFile("docker", ["build", "--pull=false", "--tag", tag, "."], { cwd: directory, timeout: 60_000 });
      await execFile("docker", ["volume", "create", volume]);
      await expect(execFile("docker", ["run", "--rm", "--mount", `type=volume,source=${volume},target=${backingPath}`, tag], { timeout: 30_000 })).resolves.toBeDefined();
      await expect(execFile("docker", ["run", "--rm", "--mount", `type=volume,source=${volume},target=${backingPath}`, tag], { timeout: 30_000 })).resolves.toBeDefined();
      for (const hostile of hostileVolumes) await execFile("docker", ["volume", "create", hostile]);
      await execFile("docker", ["run", "--rm", "-v", `${hostileVolumes[0]}:/state`, "alpine:3.22", "sh", "-ceu", "printf wrong > /state/.spawnfile-volume-init; chown -R 2000:2000 /state; chmod 600 /state/.spawnfile-volume-init"]);
      await execFile("docker", ["run", "--rm", "-v", `${hostileVolumes[1]}:/state`, "alpine:3.22", "sh", "-ceu", "printf 'spawnfile.volume-bootstrap.v1\\n' > /state/.spawnfile-volume-init; touch /state/extra; chown -R 2000:2000 /state; chmod 600 /state/.spawnfile-volume-init"]);
      await execFile("docker", ["run", "--rm", "-v", `${hostileVolumes[2]}:/state`, "alpine:3.22", "sh", "-ceu", "printf 'spawnfile.volume-bootstrap.v1\\n' > /state/target; chown -R 2000:2000 /state; chmod 600 /state/target; ln -s target /state/.spawnfile-volume-init"]);
      const wrongUidVolume = `${tag}-wrong-uid`;
      hostileVolumes.push(wrongUidVolume);
      await execFile("docker", ["volume", "create", wrongUidVolume]);
      await execFile("docker", ["run", "--rm", "-v", `${wrongUidVolume}:/state`, "alpine:3.22", "sh", "-ceu", "printf 'spawnfile.volume-bootstrap.v1\\n' > /state/.spawnfile-volume-init; chown 2000:2000 /state; chown 1001:1001 /state/.spawnfile-volume-init; chmod 600 /state/.spawnfile-volume-init"]);
      for (const hostile of hostileVolumes) await expect(execFile("docker", ["run", "--rm", "--mount", `type=volume,source=${hostile},target=${backingPath}`, tag], { timeout: 30_000 })).rejects.toThrow(/bootstrap marker mismatch|nonempty without/u);
    } finally {
      await execFile("docker", ["volume", "rm", "--force", volume]).catch(() => undefined);
      for (const hostile of hostileVolumes) await execFile("docker", ["volume", "rm", "--force", hostile]).catch(() => undefined);
      await execFile("docker", ["image", "rm", "--force", tag]).catch(() => undefined);
    }
  }, 90_000);

  it("clones git resources into the declared mount path before starting the runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-git-resource-"));
    temporaryDirectories.push(directory);
    const originPath = path.join(directory, "origin");
    const clonePath = path.join(directory, "resources", "project");
    const backingPath = path.join(directory, "backing", "project");
    await mkdir(originPath, { recursive: true });
    await execFile("git", ["init", originPath]);
    await writeFile(path.join(originPath, "README.md"), "hello from repo\n");
    await execFile("git", ["-C", originPath, "add", "README.md"]);
    await execFile("git", [
      "-C",
      originPath,
      "-c",
      "user.email=spawnfile@example.test",
      "-c",
      "user.name=Spawnfile Test",
      "commit",
      "-m",
      "init"
    ]);
    await execFile("git", ["-C", originPath, "branch", "-M", "main"]);

    const { renderEntrypoint } = await loadRenderModule({});
    const plan = createResourceRuntimePlan(
      directory,
      `test -d "${clonePath}/.git" && test "$(cat "${clonePath}/README.md")" = "hello from repo"`,
      [
        {
          branch: "main",
          id: "project",
          kind: "git",
          backingPath,
          linkPath: clonePath,
          mode: "mutable",
          mount: "./resources/project",
          sharing: "per_agent",
          url: originPath
        }
      ]
    );
    await mkdir(path.dirname(plan.instancePaths.configPath), { recursive: true });
    await writeFile(plan.instancePaths.configPath, "{}\n");

    const entrypoint = await writeExecutableEntrypoint(
      directory,
      renderEntrypoint([plan], [])
    );
    await execFile("bash", [entrypoint], { cwd: directory });

    await expect(readFile(path.join(clonePath, "README.md"), "utf8")).resolves.toBe(
      "hello from repo\n"
    );
    await expect(lstat(clonePath).then((stats) => stats.isSymbolicLink())).resolves.toBe(true);
    await expect(readlink(clonePath)).resolves.toBe(backingPath);
    await expect(readFile(path.join(backingPath, "README.md"), "utf8")).resolves.toBe(
      "hello from repo\n"
    );
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

  it("maps runtime-scoped files into the runtime install root", async () => {
    const { createRootfsFiles } = await loadRenderModule({
      pi: {
        commands: [],
        copyCommands: [],
        runtimeName: "pi",
        runtimeRoot: "/opt/runtime/pi"
      }
    });

    const files = createRootfsFiles([
      createRuntimePlan("pi", {
        runtimeRoot: "/opt/runtime/pi",
        targetFiles: [
          {
            content: "console.log('pi')\n",
            path: "runtime/app.mjs"
          }
        ]
      })
    ]);

    expect(files).toEqual([
      {
        content: "console.log('pi')\n",
        path: "container/rootfs/opt/runtime/pi/app.mjs"
      }
    ]);
  });
});
