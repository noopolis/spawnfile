import { afterEach, describe, expect, it, vi } from "vitest";

import { SpawnfileError } from "../shared/index.js";

import type { CompileReport } from "../report/index.js";

const createFakeReport = (container: CompileReport["container"]): CompileReport => ({
  container,
  diagnostics: [],
  nodes: [],
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

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../auth/index.js");
  vi.doUnmock("../filesystem/index.js");
  vi.doUnmock("./buildProject.js");
  vi.doUnmock("./runProject.js");
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
      expect.objectContaining({ containerName: "up-container" })
    );
    expect(buildProject.mock.invocationCallOrder[0]).toBeLessThan(runRunner.mock.invocationCallOrder[0]);
    expect(runRunner).toHaveBeenCalledOnce();
    expect(result.imageTag).toBe("spawnfile-up-container");
    expect(result.containerName).toBe("up-container");
    expect(result.authProfileName).toBeNull();
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
      runRunner
    });

    expect(requireAuthProfile).toHaveBeenCalledWith("prod");
    expect(createDockerRunInvocation).toHaveBeenCalledWith(
      expect.anything(),
      "spawnfile-up-container",
      expect.objectContaining({
        authProfile: { env: {}, name: "prod" },
        detach: true
      })
    );
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(result.authProfileName).toBe("prod");
    expect(result.containerName).toBe("detached-container");
  });
});
