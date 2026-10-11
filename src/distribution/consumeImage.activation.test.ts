import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { acquireHomeDeploymentLock, readDeployResources, resolveHomeRecordPath, writeHomeDeployment } from "../deployment/index.js";
import { createDefaultReleaseDependencies } from "../release/releaseDefaults.js";
import { resolveReleasePaths } from "../release/ledger.js";
import { drainAndSwap } from "../release/swap.js";
import type { ReleaseRequest } from "../release/releaseTypes.js";
import { buildDistributionReport } from "./buildDistributionReport.js";
import { consumeImageUp } from "./consumeImage.js";
import { deployResourcesAt } from "../deployment/resourceLog.js";

const doubles = vi.hoisted(() => ({ extract: vi.fn(), docker: vi.fn() }));
vi.mock("./extractImage.js", async (original) => ({ ...await original<typeof import("./extractImage.js")>(), extractImageReport: doubles.extract }));
vi.mock("./dockerRunner.js", async (original) => ({ ...await original<typeof import("./dockerRunner.js")>(), createConsumerDockerRunner: () => doubles.docker }));
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-activation-")); vi.stubEnv("SPAWNFILE_HOME", root); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each(["image", "drained-release"])("%s places activation strictly after old stop and before the new startup wake", async (mode) => {
  const report = buildDistributionReport({ envVariables: [], generatedAt: new Date().toISOString(), internalPorts: [], modelAuthMethods: {}, moltnetNetworks: [],
    organization: { agents: [], teams: [], project: "news" }, persistentMounts: [], portMappings: [], publishedPorts: [], resources: [], runtimeInstances: [],
    recording: { keep_ms: 30 * 86_400_000, memory_mount_ids: [] },
    workspaceGitResources: [{ id: "archive", agent_node_ids: ["agent:writer"], commit: "b".repeat(40), sha256: `sha256:${"c".repeat(64)}` }] });
  doubles.extract.mockResolvedValue({ report, compileFingerprint: report.compile_fingerprint });
  const oldId = "a".repeat(64), newId = "b".repeat(64), imageId = `sha256:${"c".repeat(64)}`;
  const order: string[] = [];
  let time = Date.now(), wake = "", stopped = false;
  const now = () => { order.push("clock"); time += 1; return new Date(time); };
  const start = new Date(time - 1000).toISOString();
  await writeHomeDeployment({ auth_profile: null, compile_fingerprint: report.compile_fingerprint, created_at: start, activated_at: start, activation_exact: true,
    manager: "docker", name: "news", output_directory: null, source: { kind: "image", ref: "example/news:old", digest: null }, target: { kind: "host", value: "unix:///test-only.sock" },
    units: [{ id: "news-container", kind: "container", container_id: oldId, container_name: "spawnfile-news", image_id: imageId, image_tag: "example/news:old", contains: [], runtime_instances: [] }],
    version: "spawnfile.deployment.v2" }, { ...report, workspace_git_resources: [{ ...report.workspace_git_resources![0]!, commit: "a".repeat(40) }] });
  doubles.docker.mockImplementation(async (args: string[]) => {
    if (args[0] === "rename") { order.push("rename"); return Buffer.from(""); }
    if (args[0] === "stop") { order.push("stop"); stopped = true; return Buffer.from(""); }
    if (args[0] === "run") { order.push("run"); wake = new Date(time).toISOString(); return Buffer.from(newId); }
    if (args[0] === "rm") return Buffer.from("");
    if (args[0] === "container" && args[1] === "inspect") {
      const ref = args.at(-1)!;
      if (ref === "spawnfile-news") return Buffer.from(`"${oldId}"\n"/spawnfile-news"\ntrue`);
      if (ref.startsWith("spawnfile-news-previous-")) {
        order.push("verify-stopped"); return Buffer.from(`"${oldId}"\n"/${ref}"\n${!stopped}`);
      }
      order.push("ready"); return Buffer.from(`"${newId}"\n"/spawnfile-news"\n{"Running":true,"Health":{"Status":"healthy"}}`);
    }
    if (args[0] === "image" && args.includes("{{.Id}}")) return Buffer.from(imageId);
    if (args[0] === "image" && args.includes("{{json .RepoDigests}}")) return Buffer.from("[]");
    throw new Error(`Unexpected fake Docker: ${JSON.stringify(args)}`);
  });
  if (mode === "image") await consumeImageUp("example/news:new", { deploymentName: "news", dockerHost: "unix:///test-only.sock", runDocker: doubles.docker, now });
  else {
    const deps = createDefaultReleaseDependencies();
    deps.inspectUnit = async () => ({ id: oldId, imageId, restartCount: 0, running: true, health: "healthy" });
    deps.runtimesOf = async () => ["daimon"];
    deps.requestDrain = async () => { order.push("drain"); return { drain: "draining", state: "paused" }; };
    deps.waitForDrained = async () => { order.push("drained"); return { drained: true, waitedMs: 1 }; };
    const request: ReleaseRequest = { bundleIdentity: "release", deployment: "news", dockerCommand: "docker", dockerHost: "unix:///test-only.sock",
      drain: true, drainPollMs: 1, drainTimeoutMs: 1000, envFileEnv: { SPAWNFILE_DAIMON_CONTROL_TOKEN: "test-token" }, force: false,
      inputPath: root, log: () => undefined, notifier: { kind: "none" }, notifyDeferredAfterMs: 1000, now,
      target: { kind: "host", value: "unix:///test-only.sock" }, settle: { pollMs: 1, polls: 1, stablePolls: 1 } };
    const paths = resolveReleasePaths("news", root);
    mkdirSync(paths.directory, { recursive: true });
    const release = await acquireHomeDeploymentLock("news");
    try { await drainAndSwap(request, deps, paths, "example/news:new"); } finally { await release(); }
    expect(order.indexOf("drain")).toBeLessThan(order.indexOf("drained"));
    expect(order.indexOf("drained")).toBeLessThan(order.indexOf("stop"));
  }
  const stop = order.indexOf("stop"), verify = order.indexOf("verify-stopped"), run = order.indexOf("run");
  expect(stop).toBeLessThan(verify);
  expect(order.slice(verify + 1, run + 1)).toEqual(["clock", "clock", "run"]);
  expect(run).toBeLessThan(order.indexOf("ready"));
  const file = resolveHomeRecordPath("news"), entry = deployResourcesAt(readDeployResources(file).entries, file, wake, "agent:writer")!;
  expect(entry).toMatchObject({ activated_at: wake, activation_exact: true, resources: [expect.objectContaining({ commit: "b".repeat(40) })] });
  expect(Date.parse(entry.deployed_at)).toBeGreaterThan(Date.parse(wake));
});
