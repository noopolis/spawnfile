import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { requireAuthProfile, registerImportedAuth, setAuthProfileEnv } from "../auth/index.js";
import { fileExists, readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";

import {
  createDockerRunInvocation,
  runProject,
  type RunProjectResult
} from "./runProject.js";

const fixturesRoot = path.resolve(process.cwd(), "fixtures");
const temporaryDirectories: string[] = [];
const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
const previousSearchKey = process.env.SEARCH_API_KEY;

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createCompileReport = (container: CompileReport["container"]): CompileReport => ({
  container,
  diagnostics: [],
  nodes: [],
  root: "/tmp/Spawnfile",
  spawnfile_version: "0.1"
});

afterEach(async () => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }
  if (previousAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  }
  if (previousSearchKey === undefined) {
    delete process.env.SEARCH_API_KEY;
  } else {
    process.env.SEARCH_API_KEY = previousSearchKey;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("createDockerRunInvocation", () => {
  it("writes env files, publishes ports, and mounts imported auth", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", { ANTHROPIC_API_KEY: "profile-ant" });

    const codexImport = await registerImportedAuth("dev", "codex");
    const claudeImport = await registerImportedAuth("dev", "claude-code");
    await writeUtf8File(path.join(codexImport.directory, "auth.json"), "{\"token\":\"codex\"}\n");
    await writeUtf8File(
      path.join(claudeImport.directory, ".credentials.json"),
      "{\"token\":\"claude\"}\n"
    );

    const invocation = await createDockerRunInvocation(
      {
        outputDirectory: "/tmp/spawnfile-run-out",
        report: createCompileReport({
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          ports: [18789],
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
              id: "agent-assistant",
              model_auth_methods: {
                anthropic: "api_key"
              },
              model_secrets_required: ["ANTHROPIC_API_KEY"],
              runtime: "openclaw"
            }
          ],
          runtime_homes: ["/var/lib/spawnfile/instances/openclaw/agent-assistant/home"],
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"]
        }),
        reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
      },
      "spawnfile-single-agent",
      {
        authProfile: await requireAuthProfile("dev")
      }
    );

    expect(invocation.args).toContain("--name");
    expect(invocation.args).toContain("spawnfile-single-agent");
    expect(invocation.args).toContain("--rm");
    expect(invocation.args).toContain("-p");
    expect(invocation.args).toContain("18789:18789");
    expect(invocation.args).toContain(
      `${codexImport.directory}:/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.codex`
    );
    expect(invocation.args).toContain(
      `${claudeImport.directory}:/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.claude`
    );

    const envFile = await readUtf8File(invocation.envFilePath);
    expect(envFile).toContain("ANTHROPIC_API_KEY=profile-ant");
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=");

    await removeDirectory(path.dirname(invocation.envFilePath));
  });

  it("keeps an explicitly provided runtime secret and rejects missing imported auth paths", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      OPENCLAW_GATEWAY_TOKEN: "provided-token"
    });
    const profile = await requireAuthProfile("dev");
    profile.imports.codex = {
      kind: "codex",
      path: "/tmp/does-not-exist-codex"
    };

    await expect(
      createDockerRunInvocation(
        {
          outputDirectory: "/tmp/spawnfile-run-out",
          report: createCompileReport({
            dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          ports: [18789],
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
              id: "agent-assistant",
              model_auth_methods: {
                anthropic: "api_key"
              },
              model_secrets_required: ["ANTHROPIC_API_KEY"],
              runtime: "openclaw"
            }
          ],
          runtime_homes: ["/var/lib/spawnfile/instances/openclaw/agent-assistant/home"],
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"]
        }),
          reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
        },
        "spawnfile-single-agent",
        { authProfile: profile }
      )
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "Imported auth path for codex does not exist: /tmp/does-not-exist-codex"
    });
  });

  it("supports detached runs with an explicit container name", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      OPENCLAW_GATEWAY_TOKEN: "provided-token"
    });

    const invocation = await createDockerRunInvocation(
      {
        outputDirectory: "/tmp/spawnfile-run-out",
        report: createCompileReport({
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          ports: [18789],
          runtime_instances: [],
          runtime_homes: [],
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"]
        }),
        reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
      },
      "spawnfile-single-agent",
      {
        authProfile: await requireAuthProfile("dev"),
        containerName: "custom-container",
        detach: true
      }
    );

    expect(invocation.args).toContain("-d");
    expect(invocation.args).toContain("--name");
    expect(invocation.args).toContain("custom-container");
    expect(invocation.args).not.toContain("--rm");
    expect(await readUtf8File(invocation.envFilePath)).toContain(
      "OPENCLAW_GATEWAY_TOKEN=provided-token"
    );

    await removeDirectory(invocation.supportDirectory);
  });

  it("fails when required model auth is missing", async () => {
    await expect(
      createDockerRunInvocation(
        {
          outputDirectory: "/tmp/spawnfile-run-out",
          report: createCompileReport({
            dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["MISSING_API_KEY"],
          ports: [18789],
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
              id: "agent-assistant",
              model_auth_methods: {
                missing: "api_key"
              },
              model_secrets_required: ["MISSING_API_KEY"],
              runtime: "openclaw"
            }
          ],
          runtime_homes: [],
          runtime_secrets_required: [],
          runtimes_installed: ["openclaw"],
          secrets_required: ["MISSING_API_KEY"]
        }),
          reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
        },
        "spawnfile-single-agent"
      )
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "Missing required runtime env: MISSING_API_KEY"
    });
  });

  it("fails when compile output does not include container metadata", async () => {
    await expect(
      createDockerRunInvocation(
        {
          outputDirectory: "/tmp/spawnfile-run-out",
          report: {
            diagnostics: [],
            nodes: [],
            root: "/tmp/Spawnfile",
            spawnfile_version: "0.1"
          },
          reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
        },
        "spawnfile-single-agent"
      )
    ).rejects.toMatchObject({
      code: "runtime_error",
      message: "Compile output did not include container metadata"
    });
  });
});

describe("runProject", () => {
  it("compiles the project and runs the built image with auth profile env", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      SEARCH_API_KEY: "search-key"
    });

    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    let capturedInvocationPath = "";
    const runRunner = vi.fn(async (invocation) => {
      capturedInvocationPath = invocation.envFilePath;
      expect(invocation.command).toBe("docker");
      expect(invocation.args).toContain("--name");
      expect(invocation.args).toContain("spawnfile-single-agent");
      expect(invocation.args).toContain("-p");
      expect(await readUtf8File(invocation.envFilePath)).toContain("ANTHROPIC_API_KEY=profile-ant");
      expect(await readUtf8File(invocation.envFilePath)).toContain("SEARCH_API_KEY=search-key");
    });

    const result = await runProject(path.join(fixturesRoot, "single-agent"), {
      authProfile: "dev",
      imageTag: "spawnfile-single-agent",
      outputDirectory,
      runRunner
    });

    expect(result.imageTag).toBe("spawnfile-single-agent");
    expect(result.containerName).toBe("spawnfile-single-agent");
    expect(runRunner).toHaveBeenCalledOnce();
    await expect(fileExists(capturedInvocationPath)).resolves.toBe(false);
  }, 30000);

  it("uses process env to override stored profile values", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    process.env.ANTHROPIC_API_KEY = "process-ant";
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      SEARCH_API_KEY: "search-key"
    });

    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    let result: RunProjectResult | null = null;

    result = await runProject(path.join(fixturesRoot, "single-agent"), {
      authProfile: "dev",
      imageTag: "spawnfile-single-agent",
      outputDirectory,
      runRunner: async (invocation) => {
        expect(await readUtf8File(invocation.envFilePath)).toContain("ANTHROPIC_API_KEY=process-ant");
      }
    });

    expect(result.authProfileName).toBe("dev");
  }, 30000);

  it("can run with process env only when no auth profile is selected", async () => {
    process.env.ANTHROPIC_API_KEY = "process-ant";
    process.env.SEARCH_API_KEY = "search-key";

    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    const result = await runProject(path.join(fixturesRoot, "single-agent"), {
      imageTag: "spawnfile-single-agent",
      outputDirectory,
      runRunner: async (invocation) => {
        const envFile = await readUtf8File(invocation.envFilePath);
        expect(envFile).toContain("ANTHROPIC_API_KEY=process-ant");
        expect(envFile).toContain("SEARCH_API_KEY=search-key");
      }
    });

    expect(result.authProfileName).toBeNull();
  }, 30000);

  it("keeps detached support files so runtime auth mounts remain available", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      SEARCH_API_KEY: "search-key"
    });

    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    let supportDirectory = "";

    await runProject(path.join(fixturesRoot, "single-agent"), {
      authProfile: "dev",
      detach: true,
      imageTag: "spawnfile-single-agent",
      outputDirectory,
      runRunner: async (invocation) => {
        supportDirectory = invocation.supportDirectory;
        expect(invocation.args).toContain("-d");
        expect(invocation.args).not.toContain("--rm");
        expect(await fileExists(invocation.envFilePath)).toBe(true);
      }
    });

    expect(await fileExists(path.join(supportDirectory, "run.env"))).toBe(true);
    await removeDirectory(supportDirectory);
  }, 30000);
});
