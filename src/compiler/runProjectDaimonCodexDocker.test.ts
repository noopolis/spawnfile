import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import type {
  CompileReport,
  ContainerReport,
  ContainerRuntimeInstanceReport
} from "../report/index.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

import { createDockerRunInvocation } from "./runProject.js";

const temporaryDirectories: string[] = [];
const previousDaimonCodexSource = process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
const configPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/runtime.json";
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
  const { runtime_instances: runtimeInstances, ...rest } = container;
  return {
    dockerfile: "Dockerfile",
    entrypoint: "entrypoint.sh",
    env_example: ".env.example",
    internal_ports: [],
    model_secrets_required: [],
    port_mappings: [],
    ports: [],
    published_ports: [],
    runtime_homes: [],
    runtime_instances: (runtimeInstances ?? []).map(createRuntimeInstanceReport),
    runtime_secrets_required: [],
    runtimes_installed: [],
    secrets_required: [],
    ...rest
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

const writeDaimonConfig = async (
  outputDirectory: string,
  value: unknown
): Promise<void> => {
  await writeDaimonConfigAt(outputDirectory, configPath, value);
};

const writeDaimonConfigAt = async (
  outputDirectory: string,
  targetConfigPath: string,
  value: unknown
): Promise<void> => {
  const configOutputPath = path.join(outputDirectory, "container", "rootfs", `.${targetConfigPath}`);
  await ensureDirectory(path.dirname(configOutputPath));
  await writeUtf8File(configOutputPath, JSON.stringify(value));
};

const configureCodexSource = async (): Promise<void> => {
  const codexSourceDirectory = await createTempDirectory("spawnfile-daimon-codex-source-");
  const codexSource = path.join(codexSourceDirectory, "auth.json");
  await writeUtf8File(codexSource, "{\"tokens\":{\"access_token\":\"codex-access\",\"refresh_token\":\"codex-refresh\"}}\n");
  await chmod(codexSource, 0o600);
  process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH = codexSource;
};

const dockerSecurityPostureArgs = (args: string[]): string[] =>
  args.filter((arg) => arg.startsWith("--cap-") || arg.startsWith("--security-opt"));

const baseAgent = {
  id: "agent:codex",
  name: "Codex",
  runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex",
  workspacePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents/codex"
};

const report = createCompileReport({
  runtime_instances: [{
    config_path: configPath,
    engine_by_node_id: { "agent:codex": "codex" },
    id: "daimon",
    runtime: "daimon"
  }],
  runtimes_installed: ["daimon"]
});

afterEach(async () => {
  if (previousDaimonCodexSource === undefined) {
    delete process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
  } else {
    process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH = previousDaimonCodexSource;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("Daimon Codex Docker native sandbox interop", () => {
  it("adds Docker security options only for strict native Codex sandbox configs", async () => {
    const strictOutputDirectory = await createTempDirectory("spawnfile-daimon-codex-strict-");
    const nonStrictOutputDirectory = await createTempDirectory("spawnfile-daimon-codex-default-");
    const legacyOutputDirectory = await createTempDirectory("spawnfile-daimon-codex-legacy-");
    await configureCodexSource();
    await writeDaimonConfig(strictOutputDirectory, {
      agents: [{
        ...baseAgent,
        engine: {
          codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
          kind: "codex"
        }
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    });
    await writeDaimonConfig(nonStrictOutputDirectory, {
      agents: [{ ...baseAgent, engine: { kind: "codex" } }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    });
    await writeDaimonConfig(legacyOutputDirectory, {
      agents: [],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    });

    const strictInvocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory: strictOutputDirectory,
        report,
        reportPath: path.join(strictOutputDirectory, "spawnfile-report.json")
      },
      "spawnfile-daimon-strict",
      { containerCredentialUid: process.getuid?.() }
    );
    const nonStrictInvocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory: nonStrictOutputDirectory,
        report,
        reportPath: path.join(nonStrictOutputDirectory, "spawnfile-report.json")
      },
      "spawnfile-daimon-default",
      { containerCredentialUid: process.getuid?.() }
    );
    const legacyInvocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory: legacyOutputDirectory,
        report,
        reportPath: path.join(legacyOutputDirectory, "spawnfile-report.json")
      },
      "spawnfile-daimon-legacy"
    );

    expect(dockerSecurityPostureArgs(strictInvocation.args)).toEqual([
      "--cap-drop=ALL",
      "--cap-add=CHOWN",
      "--cap-add=SETUID",
      "--cap-add=SETGID",
      "--cap-add=DAC_READ_SEARCH",
      "--cap-add=SETPCAP",
      "--cap-add=KILL",
      "--security-opt=no-new-privileges:true",
      "--security-opt=seccomp=unconfined",
      "--security-opt=apparmor=unconfined"
    ]);
    expect(dockerSecurityPostureArgs(nonStrictInvocation.args)).toEqual([
      "--cap-drop=ALL",
      "--cap-add=CHOWN",
      "--cap-add=SETUID",
      "--cap-add=SETGID",
      "--cap-add=DAC_READ_SEARCH",
      "--cap-add=SETPCAP",
      "--cap-add=KILL",
      "--security-opt=no-new-privileges:true"
    ]);
    expect(dockerSecurityPostureArgs(legacyInvocation.args)).toEqual(
      dockerSecurityPostureArgs(nonStrictInvocation.args)
    );

    await Promise.all([
      removeDirectory(strictInvocation.supportDirectory),
      removeDirectory(nonStrictInvocation.supportDirectory),
      removeDirectory(legacyInvocation.supportDirectory)
    ]);
  });

  it("fails closed when the compiled Codex sandbox policy mutates", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-codex-mutated-");
    await configureCodexSource();
    await writeDaimonConfig(outputDirectory, {
      agents: [{
        ...baseAgent,
        engine: {
          codexSandbox: { mode: "workspace-write", networkAccess: true, webSearch: "disabled" },
          kind: "codex"
        }
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    });

    await expect(createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory,
        report,
        reportPath: path.join(outputDirectory, "spawnfile-report.json")
      },
      "spawnfile-daimon-mutated",
      { containerCredentialUid: process.getuid?.() }
    )).rejects.toMatchObject({
      code: "validation_error",
      message: "Daimon Codex sandbox policy is not the supported strict workspace-no-network policy"
    });
  });

  it("validates later agents after a strict Codex agent already requires interop", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-codex-later-agent-");
    await configureCodexSource();
    await writeDaimonConfig(outputDirectory, {
      agents: [{
        ...baseAgent,
        engine: {
          codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
          kind: "codex"
        }
      }, {
        ...baseAgent,
        id: "agent:mutated",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/mutated",
        workspacePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents/mutated",
        engine: {
          codexSandbox: { mode: "workspace-write", networkAccess: true, webSearch: "disabled" },
          kind: "codex"
        }
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    });

    await expect(createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory,
        report,
        reportPath: path.join(outputDirectory, "spawnfile-report.json")
      },
      "spawnfile-daimon-later-agent",
      { containerCredentialUid: process.getuid?.() }
    )).rejects.toMatchObject({
      code: "validation_error",
      message: "Daimon Codex sandbox policy is not the supported strict workspace-no-network policy"
    });
  });

  it("validates later Daimon instances after an earlier instance already requires interop", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-codex-later-instance-");
    const secondConfigPath = "/var/lib/spawnfile/instances/daimon/daimon-secondary/daimon/runtime.json";
    await configureCodexSource();
    await writeDaimonConfig(outputDirectory, {
      agents: [{
        ...baseAgent,
        engine: {
          codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
          kind: "codex"
        }
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    });
    await writeDaimonConfigAt(outputDirectory, secondConfigPath, {
      agents: [{
        ...baseAgent,
        id: "agent:secondary",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-secondary/runtime-homes/secondary",
        workspacePath: "/var/lib/spawnfile/instances/daimon/daimon-secondary/workspace/agents/secondary",
        engine: {
          codexSandbox: { mode: "workspace-write", networkAccess: true, webSearch: "disabled" },
          kind: "codex"
        }
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    });

    await expect(createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory,
        report: createCompileReport({
          runtime_instances: [{
            config_path: configPath,
            engine_by_node_id: { "agent:codex": "codex" },
            id: "daimon",
            runtime: "daimon"
          }, {
            config_path: secondConfigPath,
            engine_by_node_id: { "agent:secondary": "codex" },
            id: "daimon-secondary",
            runtime: "daimon"
          }],
          runtimes_installed: ["daimon"]
        }),
        reportPath: path.join(outputDirectory, "spawnfile-report.json")
      },
      "spawnfile-daimon-later-instance",
      { containerCredentialUid: process.getuid?.() }
    )).rejects.toMatchObject({
      code: "validation_error",
      message: "Daimon Codex sandbox policy is not the supported strict workspace-no-network policy"
    });
  });
});
