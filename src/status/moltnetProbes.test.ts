import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeploymentRecord, DockerInspectionResult } from "../deployment/index.js";
import type { LoadedCompileReport, StatusReportMoltnetServerPlan } from "./compileReport.js";
import { collectMoltnetProbeObservations, type MoltnetFetchJson } from "./moltnetProbes.js";

const originalToken = process.env.MOLTNET_OPERATOR_TOKEN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.MOLTNET_OPERATOR_TOKEN;
  } else {
    process.env.MOLTNET_OPERATOR_TOKEN = originalToken;
  }
  globalThis.fetch = originalFetch;
});

const serverPlan = (
  overrides: Partial<StatusReportMoltnetServerPlan> = {}
): StatusReportMoltnetServerPlan => ({
  authMode: "bearer",
  baseUrl: "https://moltnet.example",
  directMessages: false,
  id: "root-local_lab",
  mode: "external",
  networkId: "local_lab",
  operatorTokenSecret: "MOLTNET_OPERATOR_TOKEN",
  port: null,
  publicRead: false,
  rooms: [
    {
      id: "floor",
      members: ["analyst", "researcher"],
      visibility: "public",
      writePolicy: "members"
    }
  ],
  storeKind: null,
  ...overrides
});

const loadedReport = (
  server: StatusReportMoltnetServerPlan
): LoadedCompileReport => ({
  kind: "loaded",
  report: {
    compileFingerprint: "sf1:abc",
    generatedAt: "2026-06-11T00:00:00.000Z",
    moltnetServers: [server],
    nodes: [],
    outputDirectory: "/project/.spawn",
    reportPath: "/project/.spawn/spawnfile-report.json",
    root: "/project/Spawnfile",
    runtimeInstances: []
  },
  reportPath: "/project/.spawn/spawnfile-report.json"
});

const deployment = (): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc",
  created_at: "2026-06-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  output_directory: "/project/.spawn",
  source: { kind: "project", root: "/project" },
  target: { kind: "host", value: "ssh://ops@example" },
  units: [
    {
      container_id: "container-123",
      container_name: "project",
      contains: [],
      id: "default-container",
      image_id: "image-123",
      image_tag: "project:latest",
      kind: "container",
      runtime_instances: []
    }
  ],
  version: "spawnfile.deployment.v2"
});

const runningInspection = (): DockerInspectionResult => new Map([
  ["default-container", {
    containerId: "container-123",
    drift: [],
    exists: true,
    exitCode: 0,
    finishedAt: null,
    imageId: "image-123",
    message: "running",
    restartCount: 0,
    running: true,
    severity: "ok",
    startedAt: "2026-06-11T00:00:00.000Z",
    status: "running",
    unitId: "default-container"
  }]
]);

const jsonForPath = (url: string): unknown => {
  if (url.endsWith("/healthz")) {
    return { status: "ok" };
  }
  if (url.endsWith("/v1/network")) {
    return {
      capabilities: { direct_messages: false },
      id: "local_lab"
    };
  }
  if (url.endsWith("/v1/rooms")) {
    return {
      rooms: [{ id: "floor", members: ["analyst", "researcher"] }]
    };
  }
  if (url.endsWith("/v1/agents")) {
    return {
      agents: [
        { connected: true, id: "analyst", rooms: ["floor"] },
        { connected: false, id: "researcher", rooms: ["floor"] }
      ]
    };
  }
  throw new Error(`unexpected url ${url}`);
};

describe("Moltnet live probes", () => {
  it("does nothing without a loaded compile report", async () => {
    await expect(collectMoltnetProbeObservations({
      deployments: [],
      fetchJson: vi.fn(),
      inspections: new Map(),
      loadedReport: { kind: "missing", reportPath: "/project/.spawn/spawnfile-report.json" }
    })).resolves.toEqual([]);
  });

  it("uses external Moltnet metadata endpoints with operator auth and never reads messages", async () => {
    process.env.MOLTNET_OPERATOR_TOKEN = "secret-token";
    const calls: string[] = [];
    const fetchJson: MoltnetFetchJson = vi.fn(async (url, headers, timeoutMs) => {
      calls.push(url);
      expect(headers).toEqual({ Authorization: "Bearer secret-token" });
      expect(timeoutMs).toBe(25);
      return { json: jsonForPath(url), ok: true };
    });

    const observations = await collectMoltnetProbeObservations({
      deployments: [],
      fetchJson,
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan()),
      timeoutMs: 25
    });

    expect(calls).toEqual([
      "https://moltnet.example/healthz",
      "https://moltnet.example/v1/network",
      "https://moltnet.example/v1/rooms",
      "https://moltnet.example/v1/agents"
    ]);
    expect(calls.join("\n")).not.toContain("messages");
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      severity: "ok",
      subject: "network:local_lab"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.agent.connected",
      severity: "warn",
      subject: "agent:researcher"
    }));
  });

  it("does not attempt anonymous access when an operator token is required", async () => {
    delete process.env.MOLTNET_OPERATOR_TOKEN;
    const fetchJson = vi.fn<MoltnetFetchJson>();

    const observations = await collectMoltnetProbeObservations({
      deployments: [],
      fetchJson,
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan())
    });

    expect(fetchJson).not.toHaveBeenCalled();
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.auth",
      severity: "unknown",
      subject: "network:local_lab"
    }));
  });

  it("uses auth-profile values before falling back to process env", async () => {
    delete process.env.MOLTNET_OPERATOR_TOKEN;
    const fetchJson: MoltnetFetchJson = vi.fn(async (url, headers) => {
      expect(headers).toEqual({ Authorization: "Bearer profile-token" });
      return { json: jsonForPath(url), ok: true };
    });

    const observations = await collectMoltnetProbeObservations({
      authValues: { MOLTNET_OPERATOR_TOKEN: "profile-token" },
      deployments: [],
      fetchJson,
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan())
    });

    expect(fetchJson).toHaveBeenCalled();
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      severity: "ok",
      subject: "network:local_lab"
    }));
  });

  it("falls back to process env when auth-profile values do not include the token", async () => {
    process.env.MOLTNET_OPERATOR_TOKEN = "env-token";
    const fetchJson: MoltnetFetchJson = vi.fn(async (url, headers) => {
      expect(headers).toEqual({ Authorization: "Bearer env-token" });
      return { json: jsonForPath(url), ok: true };
    });

    const observations = await collectMoltnetProbeObservations({
      authValues: {},
      deployments: [],
      fetchJson,
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan())
    });

    expect(fetchJson).toHaveBeenCalled();
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      severity: "ok",
      subject: "network:local_lab"
    }));
  });

  it("probes managed Moltnet servers through docker exec curl", async () => {
    process.env.MOLTNET_OPERATOR_TOKEN = "secret-token";
    const record = deployment();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const url = args.at(-1);
      if (!url) throw new Error("missing URL");
      return { stderr: "", stdout: `${JSON.stringify(jsonForPath(url))}\n` };
    });

    const observations = await collectMoltnetProbeObservations({
      deployments: [record],
      execFile,
      inspections: new Map([[record.name, runningInspection()]]),
      loadedReport: loadedReport(serverPlan({
        baseUrl: "http://127.0.0.1:8787",
        mode: "managed",
        port: 8787,
        storeKind: "memory"
      }))
    });

    expect(execFile).toHaveBeenCalledWith(
      "docker",
      [
        "--host",
        "ssh://ops@example",
        "exec",
        "container-123",
        "curl",
        "-fsS",
        "-H",
        "Authorization: Bearer secret-token",
        "http://127.0.0.1:8787/healthz"
      ],
      { timeout: 10000 }
    );
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.room",
      severity: "ok",
      subject: "room:local_lab:floor"
    }));
  });

  it("reports room, member, and server drift without throwing", async () => {
    process.env.MOLTNET_OPERATOR_TOKEN = "secret-token";
    const fetchJson: MoltnetFetchJson = async (url) => {
      if (url.endsWith("/healthz")) return { json: { status: "ok" }, ok: true };
      if (url.endsWith("/v1/network")) {
        return { json: { capabilities: { direct_messages: true }, id: "other_lab" }, ok: true };
      }
      if (url.endsWith("/v1/rooms")) return { json: { rooms: [] }, ok: true };
      if (url.endsWith("/v1/agents")) return { json: { agents: [] }, ok: true };
      return { error: "unexpected", json: null, ok: false };
    };

    const observations = await collectMoltnetProbeObservations({
      deployments: [],
      fetchJson,
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan())
    });

    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.id",
      severity: "error",
      subject: "network:local_lab"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.room",
      severity: "error",
      subject: "room:local_lab:floor"
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.direct_messages",
      severity: "warn",
      subject: "network:local_lab"
    }));
  });

  it("supports unauthenticated metadata probes and malformed metadata fallbacks", async () => {
    const fetchJson: MoltnetFetchJson = async (url, headers) => {
      expect(headers).toEqual({});
      if (url.endsWith("/healthz")) return { json: { status: "ok" }, ok: true };
      if (url.endsWith("/v1/network")) return { json: { capabilities: {}, id: 12 }, ok: true };
      if (url.endsWith("/v1/rooms")) {
        return { json: { rooms: ["bad", { id: "floor", members: ["analyst", 7] }] }, ok: true };
      }
      if (url.endsWith("/v1/agents")) {
        return {
          json: { agents: ["bad", { connected: true, id: "analyst", rooms: ["other"] }, { rooms: ["floor"] }] },
          ok: true
        };
      }
      return { error: "unexpected", json: null, ok: false };
    };

    const observations = await collectMoltnetProbeObservations({
      deployments: [],
      fetchJson,
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan({
        directMessages: null,
        operatorTokenSecret: null
      }))
    });

    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.member",
      message: expect.stringContaining("registered but not attached"),
      severity: "warn",
      subject: "agent:analyst"
    }));
    expect(observations).not.toContainEqual(expect.objectContaining({
      key: "network.direct_messages"
    }));
  });

  it("uses the default fetch client when no Moltnet client is injected", async () => {
    const jsonForDefaultFetch = (url: string): unknown => {
      if (url.endsWith("/healthz")) return { status: "ok" };
      if (url.endsWith("/v1/network")) return { capabilities: { direct_messages: false }, id: "local_lab" };
      if (url.endsWith("/v1/rooms")) return { rooms: [{ id: "floor", members: ["analyst", "researcher"] }] };
      if (url.endsWith("/v1/agents")) {
        return { agents: [{ connected: true, id: "analyst", rooms: ["floor"] }] };
      }
      throw new Error(`unexpected url ${url}`);
    };
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => ({
      json: async () => jsonForDefaultFetch(String(input)),
      ok: true,
      status: 200
    } as Response));

    const observations = await collectMoltnetProbeObservations({
      deployments: [],
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan({
        baseUrl: "https://moltnet.example/",
        operatorTokenSecret: null
      }))
    });

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(observations).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      severity: "ok"
    }));
  });

  it("normalizes default fetch HTTP and thrown failures", async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({}),
      ok: false,
      status: 503
    } as Response));

    const httpFailure = await collectMoltnetProbeObservations({
      deployments: [],
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan({ operatorTokenSecret: null }))
    });

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const thrownFailure = await collectMoltnetProbeObservations({
      deployments: [],
      inspections: new Map(),
      loadedReport: loadedReport(serverPlan({ operatorTokenSecret: null }))
    });

    expect(httpFailure).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      message: expect.stringContaining("HTTP 503"),
      severity: "unknown"
    }));
    expect(thrownFailure).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      message: expect.stringContaining("network down"),
      severity: "unknown"
    }));
  });

  it("normalizes managed Moltnet reachability failures", async () => {
    process.env.MOLTNET_OPERATOR_TOKEN = "secret-token";
    const managedServer = serverPlan({
      baseUrl: "http://127.0.0.1:8787",
      mode: "managed",
      port: 8787
    });

    const noUnit = await collectMoltnetProbeObservations({
      deployments: [],
      inspections: new Map(),
      loadedReport: loadedReport(managedServer)
    });
    const noPort = await collectMoltnetProbeObservations({
      deployments: [deployment()],
      execFile: vi.fn(),
      inspections: new Map([[deployment().name, runningInspection()]]),
      loadedReport: loadedReport({ ...managedServer, port: null })
    });
    const invalidJson = await collectMoltnetProbeObservations({
      deployments: [deployment()],
      execFile: vi.fn(async () => ({ stderr: "", stdout: "not json" })),
      inspections: new Map([[deployment().name, runningInspection()]]),
      loadedReport: loadedReport(managedServer)
    });
    const failedHttp = await collectMoltnetProbeObservations({
      deployments: [deployment()],
      execFile: vi.fn(async () => {
        throw new Error("curl failed");
      }),
      inspections: new Map([[deployment().name, runningInspection()]]),
      loadedReport: loadedReport(managedServer)
    });

    expect(noUnit).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      severity: "unknown"
    }));
    expect(noPort).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      message: expect.stringContaining("no internal port"),
      severity: "unknown"
    }));
    expect(invalidJson).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      severity: "unknown"
    }));
    expect(failedHttp).toContainEqual(expect.objectContaining({
      key: "network.reachable",
      message: expect.stringContaining("curl failed"),
      severity: "unknown"
    }));
  });
});
