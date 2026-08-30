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
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

import {
  createDockerRunInvocation,
  runProject,
  type RunProjectResult
} from "./runProject.js";

const fixturesRoot = path.resolve(process.cwd(), "examples");
const temporaryDirectories: string[] = [];
const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
const previousSearchKey = process.env.SEARCH_API_KEY;
const previousGithubToken = process.env.GH_TOKEN;
const genericOrganizationReadinessEvidence: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:000000000000", compileVersion: "0.1", hasExternalMoltnet: false,
  networks: [], organizationMembers: [], projectLabel: "generic",
  version: "spawnfile.organization-ready-evidence.v1", worldBindings: null
};

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
  delete process.env.NOOPOLIS_RUN_ID;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("runProject", () => {
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
      containerArchitecture: "amd64",
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
      containerArchitecture: "amd64",
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
      containerArchitecture: "amd64",
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
