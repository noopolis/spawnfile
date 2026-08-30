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

  it("generates a run id and stamps it into the compiled entrypoint when the host env didn't provide one", async () => {
    delete process.env.NOOPOLIS_RUN_ID;
    process.env.ANTHROPIC_API_KEY = "process-ant";
    process.env.SEARCH_API_KEY = "search-key";

    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    await runProject(path.join(fixturesRoot, "single-agent"), {
      imageTag: "spawnfile-single-agent",
      outputDirectory,
      runRunner: async () => undefined
    });

    expect(process.env.NOOPOLIS_RUN_ID).toBeTruthy();
    const entrypoint = await readUtf8File(path.join(outputDirectory, "entrypoint.sh"));
    expect(entrypoint).toContain(`NOOPOLIS_RUN_ID='${process.env.NOOPOLIS_RUN_ID}'`);
  }, 30000);

  it("reuses an already-set NOOPOLIS_RUN_ID instead of generating a new one", async () => {
    process.env.NOOPOLIS_RUN_ID = "run-from-host-real";
    process.env.ANTHROPIC_API_KEY = "process-ant";
    process.env.SEARCH_API_KEY = "search-key";

    const outputDirectory = await createTempDirectory("spawnfile-run-out-");
    await runProject(path.join(fixturesRoot, "single-agent"), {
      imageTag: "spawnfile-single-agent",
      outputDirectory,
      runRunner: async () => undefined
    });

    const entrypoint = await readUtf8File(path.join(outputDirectory, "entrypoint.sh"));
    expect(entrypoint).toContain("NOOPOLIS_RUN_ID='run-from-host-real'");
  }, 30000);

  it("removes the generated detached env file after Docker consumes it", async () => {
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

    expect(await fileExists(path.join(supportDirectory, "run.env"))).toBe(false);
    await removeDirectory(supportDirectory);
  }, 30000);
});
