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
  it("adds the complete Daimon capability set only to Daimon runs", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-capabilities-");
    const configPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/runtime.json";
    const configOutputPath = path.join(outputDirectory, "container", "rootfs", configPath);
    await ensureDirectory(path.dirname(configOutputPath));
    await writeUtf8File(configOutputPath, JSON.stringify({
      agents: [],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    }));
    const daimonInvocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory,
        report: createCompileReport({
          runtime_instances: [{ config_path: configPath, id: "daimon", runtime: "daimon" }],
          runtimes_installed: ["daimon"]
        }),
        reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
      },
      "spawnfile-daimon"
    );
    const nonDaimonInvocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
        outputDirectory: "/tmp/spawnfile-run-out",
        report: createCompileReport({
          runtime_instances: [{ config_path: "/picoclaw.json", id: "picoclaw", runtime: "picoclaw" }],
          runtimes_installed: ["picoclaw"]
        }),
        reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
      },
      "spawnfile-picoclaw"
    );

    const daimonCapabilities = [
      "--cap-drop=ALL",
      "--cap-add=CHOWN",
      "--cap-add=SETUID",
      "--cap-add=SETGID",
      "--cap-add=DAC_READ_SEARCH",
      "--cap-add=SETPCAP",
      "--cap-add=KILL"
    ];
    expect(daimonInvocation.args).toEqual(expect.arrayContaining(daimonCapabilities));
    for (const capability of daimonCapabilities) {
      expect(nonDaimonInvocation.args).not.toContain(capability);
    }

    await Promise.all([
      removeDirectory(daimonInvocation.supportDirectory),
      removeDirectory(nonDaimonInvocation.supportDirectory)
    ]);
  });

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
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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
          organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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
    process.env.NOOPOLIS_RUN_ID = "run-detached-explicit-name";
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {
      ANTHROPIC_API_KEY: "profile-ant",
      OPENCLAW_GATEWAY_TOKEN: "provided-token"
    });

    const invocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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
    expect(invocation.args).toContain("--restart");
    expect(invocation.args).toContain("unless-stopped");
    expect(invocation.args).toContain("--name");
    expect(invocation.args).toContain("custom-container");
    expect(invocation.args).not.toContain("--rm");
    expect(await readUtf8File(invocation.envFilePath)).toContain(
      "OPENCLAW_GATEWAY_TOKEN=provided-token"
    );

    await removeDirectory(invocation.supportDirectory);
  });

  it("adds docker context and identifier labels for detached deployments", async () => {
    process.env.NOOPOLIS_RUN_ID = "run-detached-labels";
    const invocation = await createDockerRunInvocation(
      {
        organizationReadinessEvidence: genericOrganizationReadinessEvidence,
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

});
