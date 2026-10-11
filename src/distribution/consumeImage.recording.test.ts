import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { acquireHomeDeploymentLock, readDeployResources, readHomeDeploymentRecord, resolveHomeRecordPath, deployResourcesAt } from "../deployment/index.js";
import { buildDistributionReport } from "./buildDistributionReport.js";
import { consumeImageUp } from "./consumeImage.js";

const extract = vi.hoisted(() => vi.fn());
vi.mock("./extractImage.js", async (original) => ({ ...await original<typeof import("./extractImage.js")>(), extractImageReport: extract }));
let home: string;
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), "spawnfile-image-recording-")); vi.stubEnv("SPAWNFILE_HOME", home); });
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it.each(["off", "on", "release", "log-failure"])("image up records pins for %s", async (mode) => {
  const pins = [{ id: "archive", agent_node_ids: ["agent:writer"], commit: "a".repeat(40), sha256: `sha256:${"b".repeat(64)}` }];
  const report = buildDistributionReport({
    envVariables: [], generatedAt: new Date().toISOString(), internalPorts: [], modelAuthMethods: {}, moltnetNetworks: [],
    organization: { agents: [], teams: [], project: "news" }, persistentMounts: [], portMappings: [], publishedPorts: [],
    resources: [], runtimeInstances: [], ...(mode === "off" ? {} : {
      recording: { keep_ms: 30 * 86_400_000, memory_mount_ids: [] }, workspaceGitResources: pins,
      workspaceBundles: [{ id: "tools", agent_node_ids: ["agent:writer"], sha256: `sha256:${"c".repeat(64)}`, origin: "prebuilt" as const }]
    })
  });
  extract.mockResolvedValue({ report, compileFingerprint: report.compile_fingerprint });
  const candidate = "d".repeat(64);
  const runDocker = vi.fn(async (args: string[]) => {
    if (args[0] === "run") return Buffer.from(candidate);
    if (args[0] === "rm") return Buffer.from(candidate);
    if (args[0] === "container" && args[1] === "inspect") {
      if (args.at(-1) === "spawnfile-news") throw new Error("No such container");
      const state = args[3]?.includes(".State.Running") ? "true" : '{"Running":true,"Health":{"Status":"healthy"}}';
      return Buffer.from(`${JSON.stringify(candidate)}\n"/spawnfile-news"\n${state}`);
    }
    if (args[0] === "image" && args.includes("{{.Id}}")) return Buffer.from(`sha256:${"e".repeat(64)}`);
    if (args[0] === "image" && args.includes("{{json .RepoDigests}}")) return Buffer.from("[]");
    throw new Error(`Unexpected fake Docker invocation: ${JSON.stringify(args)}`);
  });
  const state = path.join(home, "deployments/news");
  if (mode === "log-failure") {
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, "resource-log.jsonl"), "{torn");
    await expect(consumeImageUp("example/news:v1", { deploymentName: "news", dockerHost: "unix:///test-only.sock", runDocker }))
      .rejects.toThrow("Cannot reconcile deployment history");
    expect((await readHomeDeploymentRecord("news")).units[0]!.container_id).toBe(candidate);
    expect(runDocker.mock.calls.some(([args]) => args[0] === "rm" && args.includes(candidate))).toBe(false);
    return;
  }
  const release = mode === "release" ? await acquireHomeDeploymentLock("news") : async () => undefined;
  try {
    await consumeImageUp("example/news:v1", { deploymentName: "news", dockerHost: "unix:///test-only.sock",
      deploymentLockHeld: mode === "release", runDocker });
  } finally { await release(); }
  if (mode === "off") expect(existsSync(path.join(state, "resource-log.jsonl"))).toBe(false);
  else expect(readDeployResources(resolveHomeRecordPath("news")).entries[0]!.resources).toEqual([
    { ...pins[0], kind: "git" }, { id: "tools", agent_node_ids: ["agent:writer"], kind: "bundle", sha256: `sha256:${"c".repeat(64)}`, origin: "prebuilt" }
  ]);
});
