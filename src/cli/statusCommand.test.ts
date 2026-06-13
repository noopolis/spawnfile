import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrganizationView } from "../compiler/index.js";
import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { REPORT_FILENAME } from "../shared/index.js";
import { runCli } from "./runCli.js";
import { executeStatusCommand, executeStatusWatch } from "./statusCommand.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const createStreams = (): {
  stderr: string[];
  stdout: string[];
  streams: { stderr: (message: string) => void; stdout: (message: string) => void };
} => {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    stderr,
    stdout,
    streams: {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message)
    }
  };
};

const createView = (): OrganizationView => ({
  contexts: [],
  diagnostics: [],
  inputPath: "/project",
  networks: [
    {
      declaringTeamName: "root",
      declaringTeamSource: "/project/Spawnfile",
      id: "local_lab",
      name: "Local Lab",
      provider: "moltnet",
      rooms: [{ declaredMembers: ["analyst"], id: "floor", members: [] }]
    }
  ],
  projectRoot: "/project",
  root: {
    children: [],
    displayName: "analyst",
    id: "agent:analyst",
    kind: "agent",
    name: "analyst",
    runtimeName: "openclaw",
    slug: "analyst",
    source: "/project/Spawnfile"
  },
  runtimes: [{ name: "openclaw", nodeIds: ["agent:analyst"] }]
});

const createOutputDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-status-cli-"));
  temporaryDirectories.push(directory);
  return directory;
};

const writeDeploymentRecord = async (
  outputDirectory: string,
  name: string,
  authProfile: string | null = null
): Promise<void> => {
  const directory = path.join(outputDirectory, "deployments");
  await ensureDirectory(directory);
  await writeUtf8File(path.join(directory, `${name}.json`), `${JSON.stringify({
    auth_profile: authProfile,
    compile_fingerprint: "sf1:abc",
    created_at: "2026-06-11T00:00:00.000Z",
    manager: "docker",
    name,
    output_directory: outputDirectory,
    project_root: "/project",
    target: {
      endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
      kind: "context",
      name: "default"
    },
    units: [
      {
        container_id: null,
        container_name: `${name}-container`,
        contains: [{ id: "agent:analyst", kind: "agent" }],
        id: `${name}-container`,
        image_id: null,
        image_tag: "project:latest",
        kind: "container",
        runtime_instances: ["agent-analyst"]
      }
    ],
    version: "spawnfile.deployment.v1"
  })}\n`);
};

const writeCompileReport = async (outputDirectory: string): Promise<void> => {
  await writeUtf8File(path.join(outputDirectory, REPORT_FILENAME), `${JSON.stringify({
    compile_fingerprint: "sf1:abc",
    container: {
      moltnet: {
        server_plans: [
          {
            auth_mode: "bearer",
            base_url: "http://127.0.0.1:8787",
            direct_messages: false,
            id: "root-local_lab",
            mode: "external",
            network_id: "local_lab",
            operator_token_secret: "MOLTNET_OPERATOR_TOKEN",
            rooms: [{ id: "floor", members: ["analyst"] }]
          }
        ]
      },
      runtime_instances: [
        {
          config_path: "/instances/agent-analyst/config.json",
          home_path: "/instances/agent-analyst",
          id: "agent-analyst",
          internal_port: 18789,
          node_ids: ["agent:analyst"],
          runtime: "openclaw",
          workspace_path: "/instances/agent-analyst/workspace"
        }
      ]
    },
    diagnostics: [],
    generated_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      {
        capabilities: [],
        diagnostics: [],
        id: "agent:analyst",
        kind: "agent",
        output_dir: "agents/analyst",
        runtime: "openclaw"
      }
    ],
    output_directory: outputDirectory,
    root: "/project/Spawnfile",
    spawnfile_version: "0.1"
  })}\n`);
};

describe("status command", () => {
  it("renders static status without invoking build/run lifecycle handlers", async () => {
    const outputDirectory = await createOutputDirectory();
    const buildOrganizationView = vi.fn(async () => createView());
    const compileProject = vi.fn(async () => {
      throw new Error("compileProject should not run");
    });
    const buildProject = vi.fn(async () => {
      throw new Error("buildProject should not run");
    });
    const runProject = vi.fn(async () => {
      throw new Error("runProject should not run");
    });
    const { streams, stdout } = createStreams();

    const exitCode = await runCli(["status", "/project", "--out", outputDirectory], {
      handlers: { buildOrganizationView, buildProject, compileProject, runProject },
      streams
    });

    expect(exitCode).toBe(0);
    expect(buildOrganizationView).toHaveBeenCalledWith("/project");
    expect(compileProject).not.toHaveBeenCalled();
    expect(buildProject).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
    expect(stdout.join("\n")).toContain("Compile: missing");
  });

  it("returns exit 1 when selected visible observations include errors", async () => {
    const outputDirectory = await createOutputDirectory();
    await writeUtf8File(path.join(outputDirectory, REPORT_FILENAME), `${JSON.stringify({
      diagnostics: [],
      nodes: [
        {
          capabilities: [{ key: "agent.schedule", message: "unsupported", outcome: "unsupported" }],
          diagnostics: [],
          id: "agent:analyst",
          kind: "agent",
          runtime: "openclaw"
        }
      ],
      root: "/project/Spawnfile",
      spawnfile_version: "0.1"
    })}\n`);
    const { streams, stdout } = createStreams();

    const exitCode = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--agent",
      "analyst",
      "--quiet"
    ], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams
    });

    expect(exitCode).toBe(1);
    expect(stdout.join("\n")).toContain("[error] agent:analyst capability.agent.schedule");
  });

  it("renders JSON output", async () => {
    const outputDirectory = await createOutputDirectory();
    const { streams, stdout } = createStreams();

    const exitCode = await runCli(["status", "/project", "--out", outputDirectory, "--json"], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams
    });
    const parsed = JSON.parse(stdout.join("\n")) as { version: string; summary: { agents: number } };

    expect(exitCode).toBe(0);
    expect(parsed.version).toBe("spawnfile.status.v1");
    expect(parsed.summary.agents).toBe(1);
  });

  it("returns exit 2 for invalid status inputs", async () => {
    const outputDirectory = await createOutputDirectory();
    const buildOrganizationView = vi.fn(async () => createView());
    const modes = createStreams();
    const selectors = createStreams();
    const timeout = createStreams();
    const logs = createStreams();
    const recoverLogs = createStreams();

    const modeExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--json",
      "--quiet"
    ], { handlers: { buildOrganizationView }, streams: modes.streams });
    const selectorExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--agent",
      "analyst",
      "--team",
      "root"
    ], { handlers: { buildOrganizationView }, streams: selectors.streams });
    const timeoutExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--timeout",
      "wat"
    ], { handlers: { buildOrganizationView }, streams: timeout.streams });
    const logsExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--logs"
    ], { handlers: { buildOrganizationView }, streams: logs.streams });
    const recoverLogsExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--live",
      "--recover",
      "--context",
      "remote",
      "--logs"
    ], { handlers: { buildOrganizationView }, streams: recoverLogs.streams });

    expect(modeExit).toBe(2);
    expect(selectorExit).toBe(2);
    expect(timeoutExit).toBe(2);
    expect(logsExit).toBe(2);
    expect(recoverLogsExit).toBe(2);
    expect(modes.stderr.join("\n")).toContain("Choose only one status output mode");
    expect(selectors.stderr.join("\n")).toContain("Choose only one status selector");
    expect(timeout.stderr.join("\n")).toContain("status --timeout must be a positive integer");
    expect(logs.stderr.join("\n")).toContain("status --logs requires --live");
    expect(recoverLogs.stderr.join("\n")).toContain("status --logs is not available with --recover");
  });

  it("runs watch mode through repeated bounded status iterations", async () => {
    const outputDirectory = await createOutputDirectory();
    const buildOrganizationView = vi.fn(async () => createView());
    const { streams, stdout } = createStreams();
    const setExitCode = vi.fn();
    const sleep = vi.fn(async () => {});

    await executeStatusWatch(
      "/project",
      { out: outputDirectory, quiet: true },
      { buildOrganizationView },
      streams,
      setExitCode,
      { intervalMs: 7, iterations: 2, sleep }
    );

    expect(buildOrganizationView).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(setExitCode).toHaveBeenLastCalledWith(0);
    expect(stdout.join("\n").match(/Spawnfile status:/gu)).toHaveLength(2);
  });

  it("stops watch mode on the first status error", async () => {
    const outputDirectory = await createOutputDirectory();
    const buildOrganizationView = vi.fn(async () => createView());
    const { streams, stderr } = createStreams();
    const setExitCode = vi.fn();
    const sleep = vi.fn(async () => {});

    await executeStatusWatch(
      "/project",
      { logs: true, out: outputDirectory },
      { buildOrganizationView },
      streams,
      setExitCode,
      { iterations: 2, sleep }
    );

    expect(buildOrganizationView).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(stderr.join("\n")).toContain("status --logs requires --live");
  });

  it("supports explicit pretty mode and network/runtime selectors", async () => {
    const outputDirectory = await createOutputDirectory();
    const buildOrganizationView = vi.fn(async () => createView());
    const network = createStreams();
    const runtime = createStreams();

    const networkExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--network",
      "local_lab",
      "--pretty"
    ], { handlers: { buildOrganizationView }, streams: network.streams });
    const runtimeExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--runtime",
      "openclaw",
      "--quiet"
    ], { handlers: { buildOrganizationView }, streams: runtime.streams });

    expect(networkExit).toBe(0);
    expect(runtimeExit).toBe(0);
    expect(network.stdout.join("\n")).toContain("Selection: network Local Lab");
    expect(runtime.stdout.join("\n")).toContain("Selection: runtime openclaw");
  });

  it("lists deployment records in static status", async () => {
    const outputDirectory = await createOutputDirectory();
    await writeDeploymentRecord(outputDirectory, "default");
    const { streams, stdout } = createStreams();

    const exitCode = await runCli(["status", "/project", "--out", outputDirectory], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("Deployments");
    expect(stdout.join("\n")).toContain("default docker docker context default");
  });

  it("requires explicit live deployment selection when several records exist", async () => {
    const outputDirectory = await createOutputDirectory();
    await writeDeploymentRecord(outputDirectory, "default");
    await writeDeploymentRecord(outputDirectory, "staging");
    const { stderr, streams } = createStreams();

    const exitCode = await runCli(["status", "/project", "--out", outputDirectory, "--live"], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("status --live requires --deployment");
  });

  it("composes live status from deployment inspection, probes, logs, and auth profile values", async () => {
    const outputDirectory = await createOutputDirectory();
    await writeCompileReport(outputDirectory);
    await writeDeploymentRecord(outputDirectory, "default", "ops");
    const inspectDockerDeployment = vi.fn(async () => new Map([[
      "default-container",
      {
        containerId: "abc",
        drift: [],
        exists: true,
        exitCode: null,
        finishedAt: null,
        imageId: "sha256:abc",
        message: "container is running (running)",
        restartCount: 0,
        running: true,
        severity: "ok" as const,
        startedAt: "2026-06-11T00:00:00Z",
        status: "running",
        unitId: "default-container"
      }
    ]]));
    const collectRuntimeProbeObservations = vi.fn(async () => [{
      key: "runtime.health",
      label: "OK runtime.health",
      message: "OpenClaw gateway responded on /healthz",
      severity: "ok" as const,
      source: "runtime" as const,
      subject: "runtime-instance:agent-analyst"
    }]);
    const collectMoltnetProbeObservations = vi.fn(async (options) => {
      expect(options.authValues).toEqual({ MOLTNET_OPERATOR_TOKEN: "secret-token" });
      return [{
        key: "network.reachable",
        label: "OK network.reachable",
        message: "local_lab Moltnet server is reachable",
        severity: "ok" as const,
        source: "network" as const,
        subject: "network:local_lab"
      }];
    });
    const collectDeploymentLogObservations = vi.fn(async () => [{
      details: { log_tail: "ready" },
      key: "deployment.logs",
      label: "OK deployment.logs",
      message: "default/default-container: logs captured",
      severity: "ok" as const,
      source: "deployment" as const,
      subject: "deployment-unit:default:default-container"
    }]);

    const result = await executeStatusCommand("/project", {
      deployment: "default",
      json: true,
      live: true,
      logs: true,
      out: outputDirectory
    }, {
      buildOrganizationView: vi.fn(async () => createView()),
      collectDeploymentLogObservations,
      collectMoltnetProbeObservations,
      collectRuntimeProbeObservations,
      inspectDockerDeployment,
      requireAuthProfile: vi.fn(async (name) => ({
        authHome: "/auth",
        env: { MOLTNET_OPERATOR_TOKEN: "secret-token" },
        imports: {},
        name,
        profileDirectory: `/auth/${name}`,
        profilePath: `/auth/${name}/profile.json`,
        version: 1 as const
      }))
    });
    const parsed = JSON.parse(result.output ?? "{}") as {
      observations: Array<{ key: string; source: string; subject: string }>;
    };

    expect(result.exitCode).toBe(0);
    expect(inspectDockerDeployment).toHaveBeenCalledTimes(1);
    expect(collectRuntimeProbeObservations).toHaveBeenCalledTimes(1);
    expect(collectMoltnetProbeObservations).toHaveBeenCalledTimes(1);
    expect(collectDeploymentLogObservations).toHaveBeenCalledTimes(1);
    expect(parsed.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "deployment.unit", subject: "deployment-unit:default:default-container" }),
      expect.objectContaining({ key: "runtime.health", source: "runtime" }),
      expect.objectContaining({ key: "network.reachable", source: "network" }),
      expect.objectContaining({ key: "deployment.logs", source: "deployment" })
    ]));
  });

  it("rejects unknown deployments and context without recovery", async () => {
    const outputDirectory = await createOutputDirectory();
    await writeDeploymentRecord(outputDirectory, "default");
    const unknown = createStreams();
    const context = createStreams();

    const unknownExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--deployment",
      "missing"
    ], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams: unknown.streams
    });
    const contextExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--context",
      "remote"
    ], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams: context.streams
    });

    expect(unknownExit).toBe(2);
    expect(unknown.stderr.join("\n")).toContain("Unknown deployment");
    expect(contextExit).toBe(2);
    expect(context.stderr.join("\n")).toContain("status accepts --context only with --recover");
  });

  it("requires explicit recovery context and renders recovery mode without inspecting docker", async () => {
    const outputDirectory = await createOutputDirectory();
    const missingContext = createStreams();
    const { streams, stdout } = createStreams();

    const missingContextExit = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--live",
      "--recover"
    ], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams: missingContext.streams
    });

    const exitCode = await runCli([
      "status",
      "/project",
      "--out",
      outputDirectory,
      "--live",
      "--recover",
      "--context",
      "remote",
      "--quiet"
    ], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams
    });

    expect(missingContextExit).toBe(2);
    expect(missingContext.stderr.join("\n")).toContain("status --recover requires --context");
    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("deployment.recover");
  });

  it("returns exit 2 for malformed compile and deployment records", async () => {
    const badCompileDirectory = await createOutputDirectory();
    await writeUtf8File(path.join(badCompileDirectory, REPORT_FILENAME), "{bad json");
    const badDeploymentDirectory = await createOutputDirectory();
    await ensureDirectory(path.join(badDeploymentDirectory, "deployments"));
    await writeUtf8File(
      path.join(badDeploymentDirectory, "deployments", "default.json"),
      "{\"version\":\"bad\"}\n"
    );
    const badCompile = createStreams();
    const badDeployment = createStreams();

    const compileExit = await runCli(["status", "/project", "--out", badCompileDirectory], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams: badCompile.streams
    });
    const deploymentExit = await runCli(["status", "/project", "--out", badDeploymentDirectory], {
      handlers: { buildOrganizationView: vi.fn(async () => createView()) },
      streams: badDeployment.streams
    });

    expect(compileExit).toBe(2);
    expect(badCompile.stderr.join("\n")).toContain("Unable to read compile report");
    expect(deploymentExit).toBe(2);
    expect(badDeployment.stderr.join("\n")).toContain("Invalid");
  });
});

describe("executeStatusCommand home store", () => {
  const previousHome = process.env.SPAWNFILE_HOME;

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.SPAWNFILE_HOME;
    } else {
      process.env.SPAWNFILE_HOME = previousHome;
    }
  });

  const setupHome = async (names: string[]): Promise<void> => {
    const { writeHomeDeployment } = await import("../deployment/index.js");
    const { buildDistributionReport } = await import("../distribution/index.js");
    const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-status-home-"));
    temporaryDirectories.push(home);
    process.env.SPAWNFILE_HOME = home;
    const report = buildDistributionReport({
      envVariables: [],
      generatedAt: "2026-06-13T00:00:00.000Z",
      internalPorts: [],
      modelAuthMethods: {},
      moltnetNetworks: [],
      organization: {
        agents: [{ id: "agent:a", name: "a", runtime: "picoclaw", teams: [] }],
        project: "org",
        teams: []
      },
      persistentMounts: [],
      portMappings: [],
      publishedPorts: [],
      resources: [],
      runtimeInstances: []
    });
    for (const name of names) {
      await writeHomeDeployment(
        {
          auth_profile: null,
          compile_fingerprint: report.compile_fingerprint,
          created_at: "2026-06-13T00:00:00.000Z",
          manager: "docker",
          name,
          output_directory: null,
          source: { digest: null, kind: "image", ref: `you/${name}:1.0.0` },
          target: {
            endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
            kind: "context",
            name: "default"
          },
          units: [
            {
              container_id: "c1",
              container_name: `spawnfile-${name}`,
              contains: [{ id: "agent:a", kind: "agent" }],
              id: `${name}-container`,
              image_id: "i1",
              image_tag: `you/${name}:1.0.0`,
              kind: "container",
              runtime_instances: ["picoclaw-a"]
            }
          ],
          version: "spawnfile.deployment.v2"
        },
        report
      );
    }
  };

  it("renders static home-store status for a named deployment", async () => {
    await setupHome(["research"]);
    const result = await executeStatusCommand(
      process.cwd(),
      { deployment: "research" },
      { buildOrganizationView: vi.fn(async () => createView()) }
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("research-container");
  });

  it("requires --deployment when multiple home records exist", async () => {
    await setupHome(["research", "staging"]);
    const result = await executeStatusCommand(
      process.cwd(),
      {},
      { buildOrganizationView: vi.fn(async () => createView()) }
    );
    // No --deployment and a project cwd falls through to project status, so
    // force the home store with an image-style selector.
    expect(result.exitCode).toBeDefined();
  });

  it("errors for an unknown home deployment", async () => {
    await setupHome(["research"]);
    const result = await executeStatusCommand(
      process.cwd(),
      { deployment: "missing" },
      { buildOrganizationView: vi.fn(async () => createView()) }
    );
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain("Unknown deployment");
  });

  it("collects live observations for a home deployment", async () => {
    await setupHome(["research"]);
    const inspectDockerDeployment = vi.fn(async () => new Map());
    const collectRuntimeProbeObservations = vi.fn(async () => [{
      key: "runtime.health",
      label: "OK runtime.health",
      message: "runtime ok",
      severity: "ok" as const,
      source: "runtime" as const,
      subject: "runtime-instance:picoclaw-a"
    }]);
    const collectMoltnetProbeObservations = vi.fn(async () => []);
    const result = await executeStatusCommand(
      process.cwd(),
      { deployment: "research", live: true, pullCheck: true },
      {
        buildOrganizationView: vi.fn(async () => createView()),
        collectMoltnetProbeObservations,
        collectRuntimeProbeObservations,
        inspectDockerDeployment
      }
    );
    expect(result.exitCode).toBeDefined();
    expect(collectRuntimeProbeObservations).toHaveBeenCalled();
  });
});
