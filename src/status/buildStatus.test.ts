import { describe, expect, it } from "vitest";

import type { OrganizationView } from "../compiler/index.js";
import type { LoadedCompileReport } from "./compileReport.js";
import {
  createStaticStatus,
  exitCodeForStatus,
  getVisibleObservations
} from "./buildStatus.js";
import type { StatusDeploymentSummary, StatusObservation } from "./types.js";

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
    children: [
      {
        label: "analyst",
        node: {
          children: [],
          declared: {
            docs: [{ role: "system", source: "/project/AGENTS.md" }],
            mcpServers: [],
            model: { authMethod: "api_key", name: "gpt-5", provider: "openai" },
            packages: [],
            policy: { mode: "warn", onDegrade: "warn" },
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
          slug: "analyst",
          source: "/project/agents/analyst/Spawnfile"
        },
        relation: "team_member"
      }
    ],
    displayName: "root",
    id: "team:root",
    kind: "team",
    name: "root",
    runtimeName: null,
    slug: "root",
    source: "/project/Spawnfile"
  },
  runtimes: [{ name: "openclaw", nodeIds: ["agent:analyst"] }]
});

const loadedReport = (): LoadedCompileReport => ({
  kind: "loaded",
  report: {
    compileFingerprint: "sf1:abc",
    generatedAt: "2026-06-11T00:00:00.000Z",
    internalPorts: [18789, 8787],
    moltnetServers: [
      {
        authMode: "none",
        baseUrl: "http://127.0.0.1:8787",
        directMessages: false,
        id: "root-local_lab",
        mode: "managed",
        networkId: "local_lab",
        operatorTokenSecret: null,
        port: 8787,
        publicRead: true,
        rooms: [
          {
            id: "floor",
            members: ["analyst"],
            visibility: "public",
            writePolicy: "members"
          }
        ],
        storeKind: "memory"
      }
    ],
    nodes: [
      {
        capabilities: [{ key: "agent.schedule", message: "scheduler missing", outcome: "degraded" }],
        diagnostics: [],
        id: "agent:analyst",
        kind: "agent",
        outputDir: "runtimes/openclaw/agents/analyst",
        runtime: "openclaw"
      },
      {
        capabilities: [{ key: "team.context", message: "cannot compile", outcome: "unsupported" }],
        diagnostics: [],
        id: "team:root",
        kind: "team",
        outputDir: "teams/root",
        runtime: null
      }
    ],
    outputDirectory: "/project/.spawn",
    persistentMounts: [
      {
        id: "moltnet-local-lab-store",
        mountPath: "/var/lib/moltnet",
        reason: "managed Moltnet state",
        volumeName: "spawnfile-moltnet-store"
      }
    ],
    portMappings: [{ internalPort: 18789, publishedPort: 18789 }],
    publishedPorts: [18789],
    reportPath: "/project/.spawn/spawnfile-report.json",
    root: "/project/Spawnfile",
    runtimeInstances: [
      {
        configPath: "/instances/agent-analyst/openclaw.json",
        homePath: "/instances/agent-analyst/home",
        id: "agent-analyst",
        internalPort: 18789,
        nodeIds: ["agent:analyst"],
        publishedPort: 18789,
        runtime: "openclaw",
        workspacePath: "/instances/agent-analyst/workspace"
      }
    ],
    workspaceResources: [
      {
        backingPath: "/workspace/resources/repo",
        id: "product",
        kind: "git",
        linkPath: "/instances/agent-analyst/workspace/repos/product",
        mode: "readonly",
        mount: "./repos/product",
        sharing: "team"
      }
    ]
  },
  reportPath: "/project/.spawn/spawnfile-report.json"
});

const createDeployment = (): StatusDeploymentSummary => ({
  authProfile: null,
  compileFingerprint: "sf1:abc",
  createdAt: "2026-06-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  recordPath: "/project/.spawn/deployments/default.json",
  target: "docker context default",
  units: [
    {
      containerId: "abc",
      containerName: "spawnfile-default",
      contains: [{ id: "agent:analyst", kind: "agent" }],
      id: "default-container",
      imageId: "sha256:abc",
      imageTag: "spawnfile:latest",
      kind: "container",
      live: {
        checked: true,
        containerId: "abc",
        drift: [],
        exists: true,
        exitCode: null,
        finishedAt: null,
        imageId: "sha256:abc",
        message: "container is running (running)",
        restartCount: 0,
        running: true,
        severity: "ok",
        startedAt: "2026-06-11T00:00:00Z",
        status: "running"
      },
      runtimeInstances: ["agent-analyst"]
    }
  ]
});

const liveObservation = (
  input: Pick<StatusObservation, "key" | "source" | "subject">
): StatusObservation => ({
  ...input,
  label: `OK ${input.key}`,
  message: `${input.key} is ok`,
  severity: "ok"
});

describe("static status builder", () => {
  it("marks a missing compile report as unknown without failing", () => {
    const status = createStaticStatus(createView(), {
      kind: "missing",
      reportPath: "/project/.spawn/spawnfile-report.json"
    }, {
      inputPath: "/project",
      outputDirectory: "/project/.spawn",
      selection: null
    });

    expect(exitCodeForStatus(status)).toBe(0);
    expect(status.summary).toEqual({
      agents: 1,
      deployments: 0,
      networks: 1,
      runtimes: 1,
      teams: 1
    });
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "compile.report",
      severity: "unknown",
      subject: "compile"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "agent.declared",
      severity: "ok",
      subject: "agent:analyst"
    }));
  });

  it("maps degraded and unsupported capabilities to warn and error", () => {
    const status = createStaticStatus(createView(), loadedReport(), {
      inputPath: "/project",
      outputDirectory: "/project/.spawn",
      selection: null
    });

    expect(exitCodeForStatus(status)).toBe(1);
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "capability.agent.schedule",
      severity: "warn",
      subject: "agent:analyst"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "capability.team.context",
      severity: "error",
      subject: "team:root"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "runtime.instance",
      severity: "ok",
      subject: "runtime-instance:agent-analyst"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "network.compiled",
      severity: "ok",
      subject: "network:local_lab"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "container.ports",
      severity: "ok",
      subject: "compile"
    }));
  });

  it("filters visible observations for selectors while preserving global compile status", () => {
    const status = createStaticStatus(createView(), loadedReport(), {
      deployments: [createDeployment()],
      inputPath: "/project",
      live: {
        context: null,
        deploymentName: "default",
        logs: false,
        recover: false,
        requested: true
      },
      liveObservations: [
        liveObservation({
          key: "runtime.health",
          source: "runtime",
          subject: "runtime-instance:agent-analyst"
        })
      ],
      outputDirectory: "/project/.spawn",
      selection: {
        kind: "agent",
        label: "analyst",
        subjectKeys: ["agent:analyst"],
        value: "analyst"
      }
    });

    expect(exitCodeForStatus(status)).toBe(0);
    const subjects = getVisibleObservations(status).map((observation) => observation.subject);
    expect(subjects)
      .not.toContain("team:root");
    expect(subjects).toContain("compile");
    expect(subjects).toContain("runtime-instance:agent-analyst");
    expect(subjects).toContain("deployment-unit:default:default-container");
  });

  it("keeps runtime-instance observations visible for runtime selectors", () => {
    const status = createStaticStatus(createView(), loadedReport(), {
      inputPath: "/project",
      live: {
        context: null,
        deploymentName: "default",
        logs: false,
        recover: false,
        requested: true
      },
      liveObservations: [
        liveObservation({
          key: "runtime.ready",
          source: "runtime",
          subject: "runtime-instance:agent-analyst"
        })
      ],
      outputDirectory: "/project/.spawn",
      selection: {
        kind: "runtime",
        label: "openclaw",
        subjectKeys: ["runtime:openclaw", "agent:analyst"],
        value: "openclaw"
      }
    });

    expect(getVisibleObservations(status)).toContainEqual(expect.objectContaining({
      key: "runtime.ready",
      subject: "runtime-instance:agent-analyst"
    }));
  });

  it("keeps room and member observations visible for network selectors", () => {
    const status = createStaticStatus(createView(), loadedReport(), {
      inputPath: "/project",
      live: {
        context: null,
        deploymentName: "default",
        logs: false,
        recover: false,
        requested: true
      },
      liveObservations: [
        liveObservation({
          key: "network.room",
          source: "network",
          subject: "room:local_lab:floor"
        }),
        liveObservation({
          key: "network.agent.connected",
          source: "network",
          subject: "agent:analyst"
        })
      ],
      outputDirectory: "/project/.spawn",
      selection: {
        kind: "network",
        label: "Local Lab",
        subjectKeys: ["network:local_lab"],
        value: "local_lab"
      }
    });

    const visible = getVisibleObservations(status);
    expect(visible).toContainEqual(expect.objectContaining({
      key: "network.room",
      subject: "room:local_lab:floor"
    }));
    expect(visible).toContainEqual(expect.objectContaining({
      key: "network.agent.connected",
      subject: "agent:analyst"
    }));
  });

  it("reports compile report failures, drift, missing nodes, and extra nodes", () => {
    const status = createStaticStatus(createView(), {
      kind: "loaded",
      report: {
        compileFingerprint: null,
        generatedAt: null,
        nodes: [
          {
            capabilities: [
              { key: "agent.scheduler", message: "native", outcome: "supported" }
            ],
            diagnostics: [
              { level: "info", message: "compiled" },
              { level: "warn", message: "slow" },
              { level: "error", message: "broken" }
            ],
            id: "agent:analyst",
            kind: "agent",
            outputDir: null,
            runtime: "openclaw"
          },
          {
            capabilities: [],
            diagnostics: [],
            id: "agent:extra",
            kind: "agent",
            outputDir: null,
            runtime: "openclaw"
          }
        ],
        outputDirectory: null,
        reportPath: "/project/.spawn/spawnfile-report.json",
        root: "/other/Spawnfile",
        runtimeInstances: []
      },
      reportPath: "/project/.spawn/spawnfile-report.json"
    }, {
      inputPath: "/project",
      outputDirectory: "/project/.spawn",
      selection: null
    });

    expect(exitCodeForStatus(status)).toBe(1);
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "compile.fingerprint",
      severity: "unknown",
      subject: "compile"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "compile.root",
      severity: "warn",
      subject: "compile"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "team.compiled",
      severity: "warn",
      subject: "team:root"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "compile.extra_node",
      severity: "warn",
      subject: "agent:extra"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "diagnostic.error",
      severity: "error",
      subject: "agent:analyst"
    }));
  });

  it("adds runtime and network placeholders only for live status", () => {
    const status = createStaticStatus(createView(), {
      kind: "failure",
      failure: { exitCode: 2, message: "Malformed compile report" },
      reportPath: "/project/.spawn/spawnfile-report.json"
    }, {
      inputPath: "/project",
      live: {
        context: null,
        deploymentName: null,
        logs: false,
        recover: false,
        requested: true
      },
      outputDirectory: "/project/.spawn",
      selection: null
    });

    expect(exitCodeForStatus(status)).toBe(1);
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "compile.report",
      severity: "error",
      source: "input"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "runtime.probe",
      severity: "unknown",
      source: "runtime"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "network.probe",
      severity: "unknown",
      source: "network"
    }));
  });

  it("uses provided runtime live observations instead of runtime placeholders", () => {
    const status = createStaticStatus(createView(), loadedReport(), {
      inputPath: "/project",
      live: {
        context: null,
        deploymentName: "default",
        logs: false,
        recover: false,
        requested: true
      },
      liveObservations: [
        {
          key: "runtime.health",
          label: "OK runtime.health",
          message: "OpenClaw gateway responded on /healthz",
          severity: "ok",
          source: "runtime",
          subject: "runtime-instance:agent-analyst"
        }
      ],
      outputDirectory: "/project/.spawn",
      selection: null
    });

    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "runtime.health",
      subject: "runtime-instance:agent-analyst"
    }));
    expect(status.observations).not.toContainEqual(expect.objectContaining({
      key: "runtime.probe",
      subject: "runtime:openclaw"
    }));
    expect(status.observations).toContainEqual(expect.objectContaining({
      key: "network.probe",
      source: "network"
    }));
  });
});
