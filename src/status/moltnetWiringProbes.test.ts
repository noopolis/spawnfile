import { describe, expect, it, vi } from "vitest";

import type { LoadedCompileReport, StatusReport } from "./compileReport.js";
import { collectMoltnetWiringProbeObservations } from "./moltnetWiringProbes.js";
import type { StatusObservation } from "./types.js";

const VALID_NODE_CONFIG = JSON.stringify({
  attachments: [
    {
      agent: { id: "analyst", name: "Analyst" },
      runtime: { control_url: "http://127.0.0.1:19690/agents/analyst/wake", kind: "pi" }
    }
  ],
  moltnet: { base_url: "http://127.0.0.1:8787", network_id: "local_lab" },
  version: "moltnet.node.v1"
});

const PICOCLAW_NODE_CONFIG = JSON.stringify({
  attachments: [
    {
      agent: { id: "writer", name: "Writer" },
      runtime: { config_path: "/instances/picoclaw/agent-writer/config.json", kind: "picoclaw" }
    }
  ],
  moltnet: { base_url: "http://127.0.0.1:8787", network_id: "local_lab" },
  version: "moltnet.node.v1"
});

const loadedReport = (overrides: Partial<StatusReport> = {}): LoadedCompileReport => ({
  kind: "loaded",
  report: {
    compileFingerprint: "sf1:abc",
    generatedAt: "2026-06-11T00:00:00.000Z",
    moltnetNodePlans: [
      { configPath: "/var/lib/spawnfile/moltnet/nodes/root-local_lab-analyst.json", networkId: "local_lab" }
    ],
    moltnetServers: [
      {
        authMode: "bearer",
        baseUrl: "http://127.0.0.1:8787",
        directMessages: false,
        id: "root-local_lab",
        mode: "external",
        networkId: "local_lab",
        operatorTokenSecret: "MOLTNET_OPERATOR_TOKEN",
        port: null,
        publicRead: null,
        rooms: [{ id: "floor", members: ["analyst"], visibility: "public", writePolicy: null }],
        storeKind: null
      }
    ],
    nodes: [],
    outputDirectory: "/out",
    reportPath: "/out/spawnfile-report.json",
    root: "/project/Spawnfile",
    runtimeInstances: [],
    ...overrides
  },
  reportPath: "/out/spawnfile-report.json"
});

const observationFor = (observations: StatusObservation[], key: string, subject: string) =>
  observations.find((entry) => entry.key === key && entry.subject === subject);

describe("collectMoltnetWiringProbeObservations", () => {
  it("reports unknown for every wiring key when the compile report is missing", async () => {
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: { kind: "missing", reportPath: "/out/spawnfile-report.json" },
      outputDirectory: "/out",
      readFile: vi.fn(async () => null)
    });

    expect(observations).toHaveLength(4);
    expect(observations.every((entry) => entry.severity === "unknown")).toBe(true);
    expect(observations.map((entry) => entry.key).sort()).toEqual([
      "network.wiring.control_url",
      "network.wiring.membership",
      "network.wiring.network_resolves",
      "network.wiring.node_config"
    ]);
  });

  it("resolves node_config, control_url, network_resolves, and membership when everything is wired correctly", async () => {
    const readFile = vi.fn(async () => VALID_NODE_CONFIG);
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile
    });

    expect(readFile).toHaveBeenCalledWith(
      "/out/container/rootfs/var/lib/spawnfile/moltnet/nodes/root-local_lab-analyst.json"
    );
    expect(observationFor(observations, "network.wiring.node_config", "network:local_lab")?.severity).toBe("ok");
    expect(observationFor(observations, "network.wiring.control_url", "network:local_lab")?.severity).toBe("ok");
    expect(observationFor(observations, "network.wiring.network_resolves", "network:local_lab")?.severity).toBe("ok");
    expect(observationFor(observations, "network.wiring.membership", "room:local_lab:floor")?.severity).toBe("ok");
  });

  it("errors node_config when the file is unreadable", async () => {
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => null)
    });

    expect(observationFor(observations, "network.wiring.node_config", "network:local_lab")?.severity).toBe("error");
  });

  it("errors node_config when the file is not valid JSON or declares the wrong version", async () => {
    const malformed = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => "{not json")
    });
    expect(observationFor(malformed, "network.wiring.node_config", "network:local_lab")?.severity).toBe("error");

    const wrongVersion = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => JSON.stringify({ version: "moltnet.node.v0" }))
    });
    expect(observationFor(wrongVersion, "network.wiring.node_config", "network:local_lab")?.severity).toBe("error");
  });

  it("errors control_url when a pi attachment's control_url is mangled", async () => {
    const mangled = JSON.stringify({
      attachments: [
        {
          agent: { id: "analyst" },
          runtime: { control_url: "https://example.com/wake", kind: "pi" }
        }
      ],
      version: "moltnet.node.v1"
    });
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => mangled)
    });

    expect(observationFor(observations, "network.wiring.control_url", "network:local_lab")?.severity).toBe("error");
  });

  it("checks picoclaw attachments for a non-empty config_path", async () => {
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => PICOCLAW_NODE_CONFIG)
    });

    expect(observationFor(observations, "network.wiring.control_url", "network:local_lab")?.severity).toBe("ok");
  });

  it("errors control_url when a pi attachment omits control_url entirely", async () => {
    const missingControlUrl = JSON.stringify({
      attachments: [{ agent: { id: "analyst" }, runtime: { kind: "pi" } }],
      version: "moltnet.node.v1"
    });
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => missingControlUrl)
    });

    const observation = observationFor(observations, "network.wiring.control_url", "network:local_lab");
    expect(observation?.severity).toBe("error");
    expect(observation?.message).toContain("missing control_url");
  });

  it("errors control_url when a picoclaw attachment omits config_path entirely", async () => {
    const missingConfigPath = JSON.stringify({
      attachments: [{ agent: { id: "writer" }, runtime: { kind: "picoclaw" } }],
      version: "moltnet.node.v1"
    });
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: "/out",
      readFile: vi.fn(async () => missingConfigPath)
    });

    const observation = observationFor(observations, "network.wiring.control_url", "network:local_lab");
    expect(observation?.severity).toBe("error");
    expect(observation?.message).toContain("missing config_path");
  });

  it("errors network_resolves when the node plan's network id has no matching server plan", async () => {
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport({ moltnetServers: [] }),
      outputDirectory: "/out",
      readFile: vi.fn(async () => VALID_NODE_CONFIG)
    });

    expect(observationFor(observations, "network.wiring.network_resolves", "network:local_lab")?.severity).toBe("error");
  });

  it("warns on an orphan room member with no matching node config attachment", async () => {
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport({
        moltnetServers: [
          {
            authMode: "bearer",
            baseUrl: "http://127.0.0.1:8787",
            directMessages: false,
            id: "root-local_lab",
            mode: "external",
            networkId: "local_lab",
            operatorTokenSecret: "MOLTNET_OPERATOR_TOKEN",
            port: null,
            publicRead: null,
            rooms: [{ id: "floor", members: ["ghost"], visibility: "public", writePolicy: null }],
            storeKind: null
          }
        ]
      }),
      outputDirectory: "/out",
      readFile: vi.fn(async () => VALID_NODE_CONFIG)
    });

    const membership = observationFor(observations, "network.wiring.membership", "room:local_lab:floor");
    expect(membership?.severity).toBe("warn");
    expect(membership?.message).toContain("ghost");
  });

  it("reports unknown for node_config and no observations to check when there is no compiled output directory", async () => {
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport(),
      outputDirectory: null,
      readFile: vi.fn(async () => VALID_NODE_CONFIG)
    });

    expect(observationFor(observations, "network.wiring.node_config", "network:local_lab")?.severity).toBe("unknown");
  });

  it("emits nothing for wiring keys when the report has no moltnet plans at all", async () => {
    const observations = await collectMoltnetWiringProbeObservations({
      loadedReport: loadedReport({ moltnetNodePlans: [], moltnetServers: [] }),
      outputDirectory: "/out",
      readFile: vi.fn(async () => VALID_NODE_CONFIG)
    });

    expect(observations).toHaveLength(0);
  });
});
