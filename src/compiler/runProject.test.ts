import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { requireAuthProfile, registerImportedAuth, setAuthProfileEnv } from "../auth/index.js";
import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import type {
  CompileReport,
  ContainerReport,
  ContainerRuntimeInstanceReport
} from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

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
const previousGithubToken = process.env.GH_TOKEN;

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createTargetExecFile = () => vi.fn(async () => ({
  stderr: "",
  stdout: "\"ssh://deploy@example.com\"\n"
}));

type RuntimeInstanceInput = Partial<ContainerRuntimeInstanceReport>
  & Pick<ContainerRuntimeInstanceReport, "config_path" | "id" | "runtime">;
type ContainerReportInput = Omit<Partial<ContainerReport>, "runtime_instances"> & {
  runtime_instances?: RuntimeInstanceInput[];
};

const createRuntimeInstanceReport = (
  instance: RuntimeInstanceInput
): ContainerRuntimeInstanceReport => ({
  home_path: null,
  internal_port: null,
  model_auth_methods: {},
  model_secrets_required: [],
  node_ids: [],
  published_port: null,
  workspace_path: "/var/lib/spawnfile/workspace",
  ...instance
});

const createContainerReport = (container: ContainerReportInput): ContainerReport => {
  const ports = container.ports ?? [];
  return {
    dockerfile: "Dockerfile",
    entrypoint: "entrypoint.sh",
    env_example: ".env.example",
    internal_ports: ports,
    model_secrets_required: [],
    port_mappings: ports.map((port) => ({ internal_port: port, published_port: port })),
    ports,
    published_ports: ports,
    runtime_homes: [],
    runtime_secrets_required: [],
    runtimes_installed: [],
    secrets_required: [],
    ...container,
    runtime_instances: (container.runtime_instances ?? []).map(createRuntimeInstanceReport)
  };
};

const createCompileReport = (container: ContainerReportInput): CompileReport => ({
  compile_fingerprint: "sf1:test123",
  container: createContainerReport(container),
  diagnostics: [],
  generated_at: "2026-06-11T00:00:00.000Z",
  nodes: [],
  output_directory: "/tmp/spawnfile-run-out",
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
  if (previousGithubToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = previousGithubToken;
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
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_HOOKS_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_HOOKS_TOKEN"]
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
    expect(envFile).toContain("OPENCLAW_HOOKS_TOKEN=");

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

  it("adds docker context and identifier labels for detached deployments", async () => {
    const invocation = await createDockerRunInvocation(
      {
        outputDirectory: "/tmp/spawnfile-run-out",
        report: createCompileReport({
          model_secrets_required: [],
          ports: [],
          runtime_instances: [],
          runtime_homes: [],
          runtime_secrets_required: [],
          runtimes_installed: ["picoclaw"],
          secrets_required: []
        }),
        reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
      },
      "spawnfile-single-agent",
      {
        deploymentName: "prod-eu",
        detach: true,
        dockerContext: "hetzner"
      }
    );

    expect(invocation.args.slice(0, 3)).toEqual(["--context", "hetzner", "run"]);
    expect(invocation.args).toContain("--label");
    expect(invocation.args).toContain("com.spawnfile.deployment=prod-eu");
    expect(invocation.args).toContain("com.spawnfile.unit=prod-eu-container");
    expect(invocation.deploymentName).toBe("prod-eu");
    expect(invocation.dockerContext).toBe("hetzner");

    await removeDirectory(invocation.supportDirectory);
  });

  it("merges user env files into the generated Docker env file", async () => {
    const envDirectory = await createTempDirectory("spawnfile-run-env-");
    const envFilePath = path.join(envDirectory, ".env");
    await writeUtf8File(envFilePath, "GH_TOKEN=file-gh\nOPTIONAL_FLAG=enabled\n");

    const invocation = await createDockerRunInvocation(
      {
        outputDirectory: "/tmp/spawnfile-run-out",
        report: createCompileReport({
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: [],
          ports: [],
          runtime_instances: [],
          runtime_homes: [],
          runtime_secrets_required: [],
          runtimes_installed: ["picoclaw"],
          secrets_required: ["GH_TOKEN"]
        }),
        reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
      },
      "spawnfile-single-agent",
      { envFilePath }
    );

    const envFile = await readUtf8File(invocation.envFilePath);
    expect(envFile).toContain("GH_TOKEN=file-gh");
    expect(envFile).toContain("OPTIONAL_FLAG=enabled");

    await removeDirectory(invocation.supportDirectory);
  });

  it("mounts reported persistent state volumes", async () => {
    const invocation = await createDockerRunInvocation(
      {
        outputDirectory: "/tmp/spawnfile-run-out",
        report: createCompileReport({
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: [],
          persistent_mounts: [
            {
              id: "moltnet-local-lab-store",
              mount_path: "/var/lib/spawnfile/moltnet/networks/local-lab",
              reason: "managed Moltnet sqlite store for local-lab",
              volume_name: "spawnfile-local-lab-state"
            }
          ],
          ports: [],
          runtime_instances: [],
          runtime_homes: [],
          runtime_secrets_required: [],
          runtimes_installed: [],
          secrets_required: []
        }),
        reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
      },
      "spawnfile-single-agent"
    );

    expect(invocation.args).toContain("-v");
    expect(invocation.args).toContain(
      "spawnfile-local-lab-state:/var/lib/spawnfile/moltnet/networks/local-lab"
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
            compile_fingerprint: "sf1:test123",
            diagnostics: [],
            generated_at: "2026-06-11T00:00:00.000Z",
            nodes: [],
            output_directory: "/tmp/spawnfile-run-out",
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
      expect(invocation.args).not.toContain("-p");
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
      },
      targetExecFile: createTargetExecFile()
    });

    expect(await fileExists(path.join(supportDirectory, "run.env"))).toBe(true);
    await removeDirectory(supportDirectory);
  }, 30000);

  it("writes a deployment record after a detached run succeeds", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      SEARCH_API_KEY: "search-key"
    });

    const envDirectory = await createTempDirectory("spawnfile-run-env-");
    const envFilePath = path.join(envDirectory, "prod.env");
    await writeUtf8File(envFilePath, "OPTIONAL_FLAG=enabled\n");
    const outputDirectory = await createTempDirectory("spawnfile-run-out-");

    const result = await runProject(path.join(fixturesRoot, "single-agent"), {
      authProfile: "dev",
      deploymentName: "prod-eu",
      detach: true,
      dockerContext: "hetzner",
      envFilePath,
      imageTag: "spawnfile-single-agent",
      outputDirectory,
      runRunner: async (invocation) => {
        expect(invocation.args).toContain("com.spawnfile.deployment=prod-eu");
        return {
          containerId: "container-123",
          imageId: "image-123"
        };
      },
      targetExecFile: createTargetExecFile()
    });

    expect(result.deploymentRecordPath).toBe(path.join(outputDirectory, "deployments", "prod-eu.json"));
    const record = JSON.parse(await readUtf8File(result.deploymentRecordPath!)) as Record<string, unknown>;
    expect(record).toMatchObject({
      auth_profile: "dev",
      env_file: path.resolve(envFilePath),
      manager: "docker",
      name: "prod-eu",
      target: {
        endpoint_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{32}$/),
        kind: "context",
        name: "hetzner"
      }
    });
    expect(record).not.toHaveProperty("envFilePath");
    expect((record.units as Array<Record<string, unknown>>)[0]).toMatchObject({
      container_id: "container-123",
      container_name: "spawnfile-single-agent",
      image_id: "image-123",
      image_tag: "spawnfile-single-agent",
      kind: "container"
    });
  }, 30000);

  it("does not write a deployment record when a detached run fails", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    process.env.ANTHROPIC_API_KEY = "process-ant";
    process.env.SEARCH_API_KEY = "search-key";

    await expect(
      runProject(path.join(fixturesRoot, "single-agent"), {
        deploymentName: "prod",
        detach: true,
        imageTag: "spawnfile-single-agent",
        outputDirectory,
        runRunner: async () => {
          throw new SpawnfileError("runtime_error", "docker failed");
        }
      })
    ).rejects.toMatchObject({
      code: "runtime_error"
    });

    await expect(fileExists(path.join(outputDirectory, "deployments", "prod.json"))).resolves.toBe(false);
  }, 30000);

  it("reuses existing deployment options for detached redeploys", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      SEARCH_API_KEY: "search-key"
    });

    const envDirectory = await createTempDirectory("spawnfile-run-env-");
    const envFilePath = path.join(envDirectory, "prod.env");
    await writeUtf8File(envFilePath, "SEARCH_API_KEY=file-search\n");
    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    await runProject(path.join(fixturesRoot, "single-agent"), {
      authProfile: "dev",
      deploymentName: "prod",
      detach: true,
      dockerContext: "hetzner",
      envFilePath,
      imageTag: "spawnfile-first",
      outputDirectory,
      runRunner: async () => ({ containerId: "container-1", imageId: "image-1" }),
      targetExecFile: createTargetExecFile()
    });

    const secondTargetExecFile = createTargetExecFile();
    await runProject(path.join(fixturesRoot, "single-agent"), {
      deploymentName: "prod",
      detach: true,
      outputDirectory,
      runRunner: async (invocation) => {
        expect(invocation.args.slice(0, 3)).toEqual(["--context", "hetzner", "run"]);
        expect(invocation.args).toContain("spawnfile-first");
        expect(invocation.containerName).toBe("spawnfile-first");
        expect(await readUtf8File(invocation.envFilePath)).toContain("SEARCH_API_KEY=file-search");
        return { containerId: "container-2", imageId: "image-2" };
      },
      targetExecFile: secondTargetExecFile
    });

    const record = JSON.parse(
      await readUtf8File(path.join(outputDirectory, "deployments", "prod.json"))
    ) as Record<string, unknown>;
    expect((record.units as Array<Record<string, unknown>>)[0]).toMatchObject({
      container_id: "container-2",
      image_id: "image-2",
      image_tag: "spawnfile-first"
    });
  }, 30000);

  it("refuses detached redeploys when the recorded docker context endpoint changed", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    await ensureDirectory(path.join(outputDirectory, "deployments"));
    await writeUtf8File(path.join(outputDirectory, "deployments", "prod.json"), `${JSON.stringify({
      auth_profile: null,
      compile_fingerprint: "sf1:test123",
      created_at: "2026-06-11T00:00:00.000Z",
      manager: "docker",
      name: "prod",
      output_directory: outputDirectory,
      project_root: "/tmp/project",
      target: {
        endpoint_fingerprint: "sha256:e86b65e346836167915e2f99413f2db7",
        kind: "context",
        name: "hetzner"
      },
      units: [
        {
          container_id: "container-1",
          container_name: "spawnfile-first",
          contains: [],
          id: "prod-container",
          image_id: "image-1",
          image_tag: "spawnfile-first",
          kind: "container",
          runtime_instances: []
        }
      ],
      version: "spawnfile.deployment.v1"
    })}\n`);
    const runRunner = vi.fn(async () => undefined);

    await expect(runProject(path.join(fixturesRoot, "single-agent"), {
      deploymentName: "prod",
      detach: true,
      outputDirectory,
      runRunner,
      targetExecFile: async () => ({ stderr: "", stdout: "\"ssh://other@example.com\"\n" })
    })).rejects.toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("endpoint changed")
    });

    expect(runRunner).not.toHaveBeenCalled();
  }, 30000);
});
