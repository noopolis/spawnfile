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

describe("createDockerRunInvocation", () => {
  it("merges user env files into the generated Docker env file", async () => {
    const envDirectory = await createTempDirectory("spawnfile-run-env-");
    const envFilePath = path.join(envDirectory, ".env");
    await writeUtf8File(envFilePath, "GH_TOKEN=file-gh\nOPTIONAL_FLAG=enabled\n");

    const invocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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

    expect(invocation.args).toContain("--mount");
    expect(invocation.args).toContain(
      "type=volume,source=spawnfile-local-lab-state,target=/var/lib/spawnfile/moltnet/networks/local-lab"
    );
    expect(invocation.args.join("\n")).not.toContain("volume-nocopy");

    await removeDirectory(invocation.supportDirectory);
  });

  it("renders one stable AGY realm volume plus an opaque read-only unlock mount", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-agy-run-out-");
    const unlockDirectory = await createTempDirectory("spawnfile-agy-unlock-");
    const unlockPath = path.join(unlockDirectory, "unlock");
    const configPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/runtime.json";
    const configOutputPath = path.join(outputDirectory, "container", "rootfs", configPath);
    await ensureDirectory(path.dirname(configOutputPath));
    await writeUtf8File(configOutputPath, JSON.stringify({
      agents: [{
        engine: { kind: "agy" }, id: "agent:agy",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy"
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    }));
    await writeUtf8File(unlockPath, "unlock-canary");
    await (await import("node:fs/promises")).chmod(unlockPath, 0o600);
    const prior = process.env.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET;
    process.env.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET = unlockPath;
    try {
      const report = createCompileReport({
        persistent_mounts: [{
          id: "daimon-agy-subscription-realm",
          mount_path: "/var/lib/spawnfile/daimon/agy-subscription-realm",
          reason: "Daimon host AGY subscription realm",
          volume_name: "spawnfile-stable-agy-realm"
        }],
        runtime_instances: [{
          config_path: configPath,
          engine_by_node_id: { "agent:agy": "agy" },
          home_path: null,
          id: "daimon-organization",
          runtime: "daimon"
        }],
        runtimes_installed: ["daimon"]
      });
      const invocation = await createDockerRunInvocation({
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory,
        report,
        reportPath: path.join(outputDirectory, "spawnfile-report.json")
      // The deploying account owns the unlock fixture, so declare it as the uid
      // the container reads credentials under; the real default (2000) refuses
      // the deploy before any mount is rendered.
      }, "spawnfile-agy", { containerCredentialUid: process.getuid?.() });
      expect(invocation.args).toContain("type=volume,source=spawnfile-stable-agy-realm,target=/var/lib/spawnfile/daimon/agy-subscription-realm");
      expect(invocation.args.join("\n")).not.toContain("volume-nocopy");
      expect(invocation.args).toContain(`${unlockPath}:/var/lib/spawnfile/daimon/agy-unlock-secret:ro`);
      expect(invocation.args.join("\n")).not.toContain("unlock-canary");
      expect(await readUtf8File(invocation.envFilePath)).not.toContain("unlock-canary");
      expect(JSON.stringify(report)).not.toContain(unlockPath);
      await removeDirectory(invocation.supportDirectory);
    } finally {
      if (prior === undefined) delete process.env.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET;
      else process.env.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET = prior;
    }
  });

  it("fails when required model auth is missing", async () => {
    await expect(
      createDockerRunInvocation(
        {
          organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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
          organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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
