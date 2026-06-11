import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SpawnfileError } from "../shared/index.js";

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

const temporaryDirectories: string[] = [];

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

const createFakeReport = (container: ContainerReportInput): CompileReport => ({
  compile_fingerprint: "sf1:test123",
  container: createContainerReport(container),
  diagnostics: [],
  generated_at: "2026-06-11T00:00:00.000Z",
  nodes: [],
  output_directory: "/tmp/spawnfile-build-out",
  root: "/tmp/Spawnfile",
  spawnfile_version: "0.1"
});

const createCompileResult = (outputDirectory: string) => ({
  outputDirectory,
  report: createFakeReport({
    dockerfile: "Dockerfile",
    entrypoint: "entrypoint.sh",
    env_example: ".env.example",
    model_secrets_required: ["ANTHROPIC_API_KEY", "SEARCH_API_KEY"],
    ports: [18789],
    runtime_instances: [
      {
        config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
        id: "agent-assistant",
        model_auth_methods: {
          anthropic: "api_key" as const
        },
        model_secrets_required: ["ANTHROPIC_API_KEY", "SEARCH_API_KEY"],
        runtime: "openclaw"
      }
    ],
    runtime_homes: ["/var/lib/spawnfile/instances/openclaw/agent-assistant/home"],
    runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
    runtimes_installed: ["openclaw"],
    secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "SEARCH_API_KEY"]
  }),
  reportPath: `${outputDirectory}/spawnfile-report.json`
});

const loadUpProjectModule = async () => {
  const buildProject = vi.fn(async (inputPath: string, options: Record<string, unknown>) => ({
    ...createCompileResult("/tmp/spawnfile-build-out"),
    imageTag: options.imageTag as string | undefined
  }));
  const createDockerRunInvocation = vi.fn(async (
    _: unknown,
    imageTag: string,
    options: { containerName?: string | undefined }
  ) => ({
    args: ["run", "--rm", "--name", "spawnfile-up-container", "spawnfile-up-container"],
    command: "docker",
    containerName: options.containerName ?? "spawnfile-up-container",
    cwd: "/tmp/spawnfile-build-out",
    detach: false,
    deploymentName: null,
    dockerContext: null,
    envFilePath: "/tmp/spawnfile-run-support/run.env",
    imageTag,
    supportDirectory: "/tmp/spawnfile-run-support"
  }));
  const runDockerContainer = vi.fn(async () => {
    throw new Error("runDockerContainer should not be called when runRunner is injected");
  });

  vi.doMock("./buildProject.js", async () => ({
    ...await vi.importActual<typeof import("./buildProject.js")>("./buildProject.js"),
    buildProject
  }));
  vi.doMock("./runProject.js", async () => ({
    ...await vi.importActual<typeof import("./runProject.js")>("./runProject.js"),
    createDockerRunInvocation,
    runDockerContainer
  }));

  const module = await import("./upProject.js");
  return { ...module, buildProject, createDockerRunInvocation, runDockerContainer };
};

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("../auth/index.js");
  vi.doUnmock("../filesystem/index.js");
  vi.doUnmock("../deployment/index.js");
  vi.doUnmock("./buildProject.js");
  vi.doUnmock("./runProject.js");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("upProject", () => {
  it("builds then runs using injected runners", async () => {
    const { upProject, buildProject, createDockerRunInvocation } = await loadUpProjectModule();
    const runRunner = vi.fn(async (invocation: { args: string[] }) => {
      expect(invocation.args).toContain("spawnfile-up-container");
    });

    const result = await upProject("/tmp/project", {
      buildRunner: async () => undefined,
      containerName: "up-container",
      imageTag: "spawnfile-up-container",
      runRunner
    });

    expect(buildProject).toHaveBeenCalledWith("/tmp/project", {
      buildRunner: expect.any(Function),
      clean: undefined,
      dockerCommand: undefined,
      imageTag: "spawnfile-up-container",
      outputDirectory: undefined
    });
    expect(createDockerRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        imageTag: "spawnfile-up-container"
      }),
      "spawnfile-up-container",
      expect.objectContaining({
        containerName: "up-container",
        deploymentName: undefined,
        dockerContext: undefined
      })
    );
    expect(buildProject.mock.invocationCallOrder[0]).toBeLessThan(runRunner.mock.invocationCallOrder[0]);
    expect(runRunner).toHaveBeenCalledOnce();
    expect(result.imageTag).toBe("spawnfile-up-container");
    expect(result.containerName).toBe("up-container");
    expect(result.authProfileName).toBeNull();
    expect(result.supportDirectory).toBe("/tmp/spawnfile-run-support");
  });

  it("does not start runtime when planning fails", async () => {
    const buildProject = vi.fn(async () => ({
      ...createCompileResult("/tmp/spawnfile-build-out"),
      imageTag: "spawnfile-up-container"
    }));
    const createDockerRunInvocation = vi.fn(async () => {
      throw new SpawnfileError("validation_error", "Missing required runtime env: ANTHROPIC_API_KEY");
    });

    vi.doMock("./buildProject.js", async () => ({
      ...await vi.importActual<typeof import("./buildProject.js")>("./buildProject.js"),
      buildProject
    }));
    vi.doMock("./runProject.js", async () => ({
      ...await vi.importActual<typeof import("./runProject.js")>("./runProject.js"),
      createDockerRunInvocation,
      runDockerContainer: vi.fn()
    }));

    const { upProject } = await import("./upProject.js");
    const runRunner = vi.fn(async () => undefined);

    await expect(
      upProject("/tmp/project", { imageTag: "spawnfile-up-container", runRunner })
    ).rejects.toMatchObject({
      code: "validation_error"
    });

    expect(runRunner).not.toHaveBeenCalled();
  });

  it("loads auth profiles and preserves support files for detached containers", async () => {
    const buildProject = vi.fn(async () => ({
      ...createCompileResult("/tmp/spawnfile-build-out"),
      imageTag: "spawnfile-up-container"
    }));
    const createDockerRunInvocation = vi.fn(async () => ({
      args: ["run", "--detach", "spawnfile-up-container"],
      command: "docker",
      containerName: "detached-container",
      cwd: "/tmp/spawnfile-build-out",
      detach: true,
      deploymentName: "default",
      dockerContext: null,
      envFilePath: "/tmp/spawnfile-run-support/run.env",
      imageTag: "spawnfile-up-container",
      supportDirectory: "/tmp/spawnfile-run-support"
    }));
    const runRunner = vi.fn(async () => undefined);
    const requireAuthProfile = vi.fn(async () => ({ env: {}, name: "prod" }));
    const removeDirectory = vi.fn(async () => undefined);

    vi.doMock("../auth/index.js", async () => ({
      ...await vi.importActual<typeof import("../auth/index.js")>("../auth/index.js"),
      requireAuthProfile
    }));
    vi.doMock("../filesystem/index.js", async () => ({
      ...await vi.importActual<typeof import("../filesystem/index.js")>("../filesystem/index.js"),
      removeDirectory
    }));
    vi.doMock("./buildProject.js", async () => ({
      ...await vi.importActual<typeof import("./buildProject.js")>("./buildProject.js"),
      buildProject
    }));
    vi.doMock("./runProject.js", async () => ({
      ...await vi.importActual<typeof import("./runProject.js")>("./runProject.js"),
      createDockerRunInvocation,
      runDockerContainer: vi.fn()
    }));

    const { upProject } = await import("./upProject.js");

    const result = await upProject("/tmp/project", {
      authProfile: "prod",
      detach: true,
      imageTag: "spawnfile-up-container",
      runRunner,
      targetExecFile: createTargetExecFile()
    });

    expect(requireAuthProfile).toHaveBeenCalledWith("prod");
    expect(createDockerRunInvocation).toHaveBeenCalledWith(
      expect.anything(),
      "spawnfile-up-container",
      expect.objectContaining({
        authProfile: { env: {}, name: "prod" },
        deploymentName: "default",
        detach: true,
        dockerContext: undefined
      })
    );
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(result.authProfileName).toBe("prod");
    expect(result.containerName).toBe("detached-container");
    expect(result.supportDirectory).toBe("/tmp/spawnfile-run-support");
  });

  it("writes a deployment record after a detached up succeeds", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-up-out-");
    const buildProject = vi.fn(async () => ({
      ...createCompileResult(outputDirectory),
      imageTag: "spawnfile-up-container"
    }));
    const createDockerRunInvocation = vi.fn(async () => ({
      args: ["--context", "hetzner", "run", "-d", "spawnfile-up-container"],
      command: "docker",
      containerName: "detached-container",
      cwd: outputDirectory,
      detach: true,
      deploymentName: "prod",
      dockerContext: "hetzner",
      envFilePath: "/tmp/spawnfile-run-support/run.env",
      imageTag: "spawnfile-up-container",
      supportDirectory: "/tmp/spawnfile-run-support"
    }));
    const runRunner = vi.fn(async () => ({ containerId: "container-123" }));

    vi.doMock("./buildProject.js", async () => ({
      ...await vi.importActual<typeof import("./buildProject.js")>("./buildProject.js"),
      buildProject
    }));
    vi.doMock("./runProject.js", async () => ({
      ...await vi.importActual<typeof import("./runProject.js")>("./runProject.js"),
      createDockerRunInvocation,
      runDockerContainer: vi.fn()
    }));

    const { upProject } = await import("./upProject.js");
    const result = await upProject("/tmp/project", {
      deploymentName: "prod",
      detach: true,
      dockerContext: "hetzner",
      imageTag: "spawnfile-up-container",
      runRunner,
      targetExecFile: createTargetExecFile()
    });

    expect(createDockerRunInvocation).toHaveBeenCalledWith(
      expect.anything(),
      "spawnfile-up-container",
      expect.objectContaining({
        deploymentName: "prod",
        dockerContext: "hetzner"
      })
    );
    expect(result.deploymentRecordPath).toBe(path.join(outputDirectory, "deployments", "prod.json"));
    expect(await fileExists(result.deploymentRecordPath!)).toBe(true);
    const record = JSON.parse(await readUtf8File(result.deploymentRecordPath!)) as Record<string, unknown>;
    expect(record).toMatchObject({
      manager: "docker",
      name: "prod",
      target: {
        kind: "context",
        name: "hetzner"
      }
    });
    expect((record.units as Array<Record<string, unknown>>)[0]).toMatchObject({
      container_id: "container-123",
      container_name: "detached-container"
    });
  });

  it("reuses recorded deployment settings before building detached redeploys", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-up-out-");
    const envDirectory = await createTempDirectory("spawnfile-up-env-");
    const envFilePath = path.join(envDirectory, "prod.env");
    await writeUtf8File(envFilePath, "SEARCH_API_KEY=file-search\n");
    await ensureDirectory(path.join(outputDirectory, "deployments"));
    await writeUtf8File(path.join(outputDirectory, "deployments", "prod.json"), `${JSON.stringify({
      auth_profile: "prod",
      compile_fingerprint: "sf1:test123",
      created_at: "2026-06-11T00:00:00.000Z",
      env_file: envFilePath,
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

    const buildProject = vi.fn(async (_inputPath: string, options: Record<string, unknown>) => ({
      ...createCompileResult(outputDirectory),
      imageTag: options.imageTag as string
    }));
    const createDockerRunInvocation = vi.fn(async (
      _: unknown,
      imageTag: string,
      options: {
        authProfile?: { name: string } | null;
        containerName?: string;
        dockerContext?: string;
        envFilePath?: string;
      }
    ) => ({
      args: ["--context", options.dockerContext, "run", "-d", imageTag],
      command: "docker",
      containerName: options.containerName ?? "detached-container",
      cwd: outputDirectory,
      detach: true,
      deploymentName: "prod",
      dockerContext: options.dockerContext ?? null,
      envFilePath: "/tmp/spawnfile-run-support/run.env",
      imageTag,
      supportDirectory: "/tmp/spawnfile-run-support"
    }));
    const requireAuthProfile = vi.fn(async () => ({ env: {}, name: "prod" }));

    vi.doMock("../auth/index.js", async () => ({
      ...await vi.importActual<typeof import("../auth/index.js")>("../auth/index.js"),
      requireAuthProfile
    }));
    vi.doMock("./buildProject.js", async () => ({
      ...await vi.importActual<typeof import("./buildProject.js")>("./buildProject.js"),
      buildProject
    }));
    vi.doMock("./runProject.js", async () => ({
      ...await vi.importActual<typeof import("./runProject.js")>("./runProject.js"),
      createDockerRunInvocation,
      runDockerContainer: vi.fn()
    }));

    const { upProject } = await import("./upProject.js");
    await upProject("/tmp/project", {
      deploymentName: "prod",
      detach: true,
      outputDirectory,
      runRunner: async () => ({ containerId: "container-2", imageId: "image-2" }),
      targetExecFile: createTargetExecFile()
    });

    expect(buildProject).toHaveBeenCalledWith("/tmp/project", expect.objectContaining({
      imageTag: "spawnfile-first"
    }));
    expect(requireAuthProfile).toHaveBeenCalledWith("prod");
    expect(createDockerRunInvocation).toHaveBeenCalledWith(
      expect.anything(),
      "spawnfile-first",
      expect.objectContaining({
        containerName: "spawnfile-first",
        dockerContext: "hetzner",
        envFilePath
      })
    );
  });

  it("refuses detached redeploys when the recorded docker context endpoint changed", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-up-out-");
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
    const buildRunner = vi.fn(async () => undefined);
    const runRunner = vi.fn(async () => undefined);

    const { upProject } = await import("./upProject.js");
    await expect(upProject("/tmp/project", {
      buildRunner,
      deploymentName: "prod",
      detach: true,
      outputDirectory,
      runRunner,
      targetExecFile: async () => ({ stderr: "", stdout: "\"ssh://other@example.com\"\n" })
    })).rejects.toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("endpoint changed")
    });

    expect(buildRunner).not.toHaveBeenCalled();
    expect(runRunner).not.toHaveBeenCalled();
  });
});
