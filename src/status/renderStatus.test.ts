import { describe, expect, it } from "vitest";

import type { StaticStatus } from "./types.js";
import { renderStatus } from "./renderStatus.js";

const createStatus = (): StaticStatus => ({
  compile: {
    compileFingerprint: null,
    generatedAt: null,
    outputDirectory: null,
    path: "/project/.spawn/spawnfile-report.json",
    present: false,
    root: null
  },
  deployments: [],
  inputPath: "/project",
  live: {
    context: null,
    deploymentName: null,
    logs: false,
    recover: false,
    requested: false
  },
  observations: [
    {
      key: "source.valid",
      label: "OK source.valid",
      message: "Loaded source",
      severity: "ok",
      source: "declared",
      subject: "status"
    },
    {
      key: "agent.declared",
      label: "OK agent.declared",
      message: "analyst is declared",
      severity: "ok",
      source: "declared",
      subject: "agent:analyst"
    },
    {
      key: "compile.report",
      label: "UNKNOWN compile.report",
      message: "Compile report not found",
      severity: "unknown",
      source: "compile_report",
      subject: "compile"
    }
  ],
  outputDirectory: "/project/.spawn",
  projectRoot: "/project",
  selection: null,
  summary: { agents: 1, deployments: 0, networks: 0, runtimes: 1, teams: 0 },
  version: "spawnfile.status.v1",
  view: {
    contexts: [],
    diagnostics: [],
    inputPath: "/project",
    networks: [],
    projectRoot: "/project",
    root: {
      children: [],
      declared: {
        docs: [{ role: "system", source: "/project/AGENTS.md" }],
        mcpServers: [],
        model: null,
        packages: [],
        policy: { mode: null, onDegrade: null },
        resources: [],
        schedule: null,
        skills: [],
        surfaces: []
      },
      displayName: "analyst",
      id: "agent:analyst",
      kind: "agent",
      name: "analyst",
      runtimeName: "openclaw",
      source: "/project/Spawnfile"
    },
    runtimes: [{ name: "openclaw", nodeIds: ["agent:analyst"] }]
  }
});

describe("status renderer", () => {
  it("renders pretty output with tree annotations and declared details", () => {
    const output = renderStatus(createStatus(), { mode: "pretty" });

    expect(output).toContain("Spawnfile status: .");
    expect(output).toContain("agent analyst [openclaw] runtime=openclaw  status=ok");
    expect(output).toContain("docs: system");
    expect(output).toContain("[unknown] compile compile.report");
  });

  it("renders quiet output with summary and non-ok observations only", () => {
    const output = renderStatus(createStatus(), { mode: "quiet" });

    expect(output).toContain("Summary: 1 agent, 0 teams");
    expect(output).toContain("[unknown] compile compile.report");
    expect(output).not.toContain("analyst is declared");
  });

  it("renders a JSON status envelope", () => {
    const parsed = JSON.parse(renderStatus(createStatus(), { mode: "json" })) as {
      version: string;
      observations: unknown[];
      view: { root: { id: string } };
    };

    expect(parsed.version).toBe("spawnfile.status.v1");
    expect(parsed.view.root.id).toBe("agent:analyst");
    expect(parsed.observations).toHaveLength(3);
  });

  it("renders structured observation details in pretty and JSON output", () => {
    const status = createStatus();
    status.observations.push({
      details: {
        log_tail: "token=[REDACTED]\n/project/runtime ready\n",
        next_run_at: "2026-06-11T01:00:00.000Z"
      },
      key: "deployment.logs",
      label: "OK deployment.logs",
      message: "redacted logs collected",
      severity: "ok",
      source: "deployment",
      subject: "deployment-unit:prod:agent"
    });

    const pretty = renderStatus(status, { mode: "pretty" });
    const parsed = JSON.parse(renderStatus(status, { mode: "json" })) as {
      observations: Array<{ details?: Record<string, unknown> }>;
    };

    expect(pretty).toContain("Details");
    expect(pretty).toContain("token=[REDACTED]");
    expect(pretty).toContain("./runtime ready");
    expect(pretty).toContain("next_run_at: 2026-06-11T01:00:00.000Z");
    expect(parsed.observations.at(-1)?.details?.log_tail).toContain("[REDACTED]");
  });

  it("renders deployment details and live selection headers", () => {
    const status = createStatus();
    status.live = {
      context: null,
      deploymentName: "prod",
      logs: false,
      recover: false,
      requested: true
    };
    status.deployments = [
      {
        authProfile: null,
        compileFingerprint: "sf1:abc",
        createdAt: "2026-06-11T00:00:00.000Z",
        manager: "docker",
        name: "prod",
        recordPath: "/project/.spawn/deployments/prod.json",
        target: "docker context prod",
        units: [
          {
            containerId: "container-123",
            containerName: "project-prod",
            contains: [],
            id: "prod-container",
            imageId: "image-123",
            imageTag: "project:latest",
            kind: "container",
            live: {
              checked: true,
              containerId: "container-123",
              drift: [],
              exists: true,
              exitCode: 0,
              finishedAt: null,
              imageId: "image-123",
              message: "container is running (running)",
              restartCount: 1,
              running: true,
              severity: "ok",
              startedAt: "2026-06-11T00:00:00.000Z",
              status: "running"
            },
            runtimeInstances: []
          }
        ]
      }
    ];
    status.summary.deployments = 1;

    const output = renderStatus(status, { mode: "pretty" });

    expect(output).toContain("Live: requested deployment=prod");
    expect(output).toContain("Deployments");
    expect(output).toContain("record: .spawn/deployments/prod.json");
    expect(output).toContain("image: project:latest (image-123)");
    expect(output).toContain("container: project-prod (container-123)");
    expect(output).toContain("contains: none");
    expect(output).toContain("live: container is running (running)");
  });

  it("renders selected networks, runtimes, and deployment matches", () => {
    const networkStatus = createStatus();
    networkStatus.selection = {
      kind: "network",
      label: "Local Lab",
      subjectKeys: ["network:local_lab"],
      value: "local_lab"
    };
    networkStatus.view.networks = [
      {
        declaringTeamName: "root",
        declaringTeamSource: "/project/Spawnfile",
        id: "local_lab",
        name: "Local Lab",
        provider: "moltnet",
        rooms: [{ declaredMembers: [], id: "empty", members: [] }]
      }
    ];

    const runtimeStatus = createStatus();
    runtimeStatus.selection = {
      kind: "runtime",
      label: "openclaw",
      subjectKeys: ["runtime:openclaw", "runtime-instance:agent-analyst"],
      value: "openclaw"
    };
    runtimeStatus.deployments = [
      {
        authProfile: "prod",
        compileFingerprint: "sf1:abc",
        createdAt: "2026-06-11T00:00:00.000Z",
        manager: "docker",
        name: "prod",
        recordPath: "/project/.spawn/deployments/prod.json",
        target: "docker context prod",
        units: [
          {
            containerId: null,
            containerName: null,
            contains: [],
            id: "prod-container",
            imageId: null,
            imageTag: "project:latest",
            kind: "container",
            live: null,
            runtimeInstances: ["agent-analyst"]
          }
        ]
      }
    ];
    runtimeStatus.summary.deployments = 1;

    const networkOutput = renderStatus(networkStatus, { mode: "pretty" });
    const runtimeOutput = renderStatus(runtimeStatus, { mode: "pretty" });

    expect(networkOutput).toContain("Selection: network Local Lab");
    expect(networkOutput).toContain("rooms: empty[]");
    expect(networkOutput).not.toContain("Nodes");
    expect(runtimeOutput).toContain("Selection: runtime openclaw");
    expect(runtimeOutput).toContain("Deployments");
    expect(runtimeOutput).toContain("auth-profile: prod");
    expect(runtimeOutput).toContain("runtimes: agent-analyst");
  });
});
