import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { buildDistributionReport } from "../distribution/index.js";
import { createDockerDeploymentRecord } from "./dockerManager.js";
import { resolveHomeRecordPath, writeHomeDeployment } from "./homeStore.js";
import { resolveDeploymentRecordPath } from "./names.js";
import { readDeploymentRecord, writeDeploymentRecord } from "./record.js";
import { bindDeploymentRecording } from "./recordPublication.js";
import { deployResourceLogPath, readDeployResources } from "./resourceLog.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "spawnfile-publication-"));
  vi.stubEnv("SPAWNFILE_HOME", path.join(root, "home"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
const reportFor = (pin: string, enabled = true) => buildDistributionReport({
  envVariables: [], generatedAt: new Date().toISOString(), internalPorts: [], modelAuthMethods: {}, moltnetNetworks: [],
  organization: { agents: [], teams: [], project: "news" }, persistentMounts: [], portMappings: [], publishedPorts: [],
  resources: [], runtimeInstances: [], ...(enabled ? { recording: { keep_ms: 30 * 86_400_000, memory_mount_ids: ["memory"] },
    workspaceGitResources: [{ id: "archive", agent_node_ids: ["agent:writer"], commit: pin.repeat(40), sha256: `sha256:${pin.repeat(64)}` }] } : {})
});
const publish = async (mode: string, pin: string, enabled = true) => {
  const report = reportFor(pin, enabled);
  const record = createDockerDeploymentRecord({ authProfileName: null, compileFingerprint: report.compile_fingerprint,
    containerName: "news", imageTag: "org/news:v1", nodes: [], outputDirectory: root, projectRoot: root, runtimeInstanceIds: [],
    activated_at: new Date(Date.now() - 100).toISOString(), activation_exact: true,
    target: { kind: "host", value: "unix:///test-only.sock" } });
  const file = mode === "home" ? resolveHomeRecordPath("default") : resolveDeploymentRecordPath(root, "default");
  if (mode === "home") await writeHomeDeployment({ ...record, output_directory: null, source: { kind: "image", ref: "org/news:v1", digest: null } }, report);
  else await writeDeploymentRecord(root, bindDeploymentRecording(file, record, report, JSON.stringify(report)));
  return file;
};

it.each(["project", "home"])("%s reconciles failed B before publishing different C, preserving B's original instant", async (mode) => {
  const file = await publish(mode, "a");
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  const open = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation((name, ...args) => {
    if (name === deployResourceLogPath(file)) throw new Error("B append failed");
    return open(name, ...args);
  });
  await expect(publish(mode, "b")).rejects.toThrow("B append failed");
  const pending = (await readDeploymentRecord(file)).resource_snapshot!;
  expect(pending.resources[0]).toMatchObject({ commit: "b".repeat(40) });
  vi.restoreAllMocks();
  vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
  await publish(mode, "c");
  const history = readDeployResources(file);
  expect(history.errors).toEqual([]);
  expect(history.entries.map((entry) => entry.resources[0])).toMatchObject([
    { commit: "a".repeat(40) }, { commit: "b".repeat(40) }, { commit: "c".repeat(40) }
  ]);
  expect(history.entries[1]).toEqual(pending);
  expect((await readDeploymentRecord(file)).recording).toEqual({ keep_ms: 30 * 86_400_000, memory_mount_ids: ["memory"] });
});

it.each(["project", "home"])("%s blocks replacement if predecessor reconciliation fails, even when switching recording off", async (mode) => {
  const file = await publish(mode, "a");
  fs.unlinkSync(deployResourceLogPath(file));
  const before = fs.readFileSync(file, "utf8");
  const cached = mode === "home" ? fs.readFileSync(path.join(path.dirname(file), "spawnfile-report.json"), "utf8") : null;
  const open = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation((name, ...args) => {
    if (name === deployResourceLogPath(file)) throw new Error("reconcile failed");
    return open(name, ...args);
  });
  await expect(publish(mode, "b", false)).rejects.toThrow("reconcile failed");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  if (cached) expect(fs.readFileSync(path.join(path.dirname(file), "spawnfile-report.json"), "utf8")).toBe(cached);
  vi.restoreAllMocks();
  await publish(mode, "b", false);
  expect(readDeployResources(file).entries).toHaveLength(1);
  expect((await readDeploymentRecord(file)).recording).toBeUndefined();
});

it.each(["project", "home"])("%s syncs record and report files and rename directories before log write/fsync", async (mode) => {
  const events: string[] = [], handles = new Map<number, string>();
  const open = asyncFs.open, rename = asyncFs.rename, syncOpen = fs.openSync, syncWrite = fs.writeSync, sync = fs.fsyncSync;
  vi.spyOn(asyncFs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args), name = String(args[0]);
    return new Proxy(handle, { get(target, key) {
      if (key === "sync") return async () => { await target.sync(); events.push(`sync:${name}`); };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  vi.spyOn(asyncFs, "rename").mockImplementation(async (from, to) => { await rename(from, to); events.push(`rename:${String(to)}`); });
  vi.spyOn(fs, "openSync").mockImplementation((name, ...args) => { const fd = syncOpen(name, ...args); handles.set(fd, String(name)); return fd; });
  vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Uint8Array) => {
    events.push(`write:${handles.get(fd)}`); return syncWrite(fd, bytes);
  }) as typeof fs.writeSync);
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { sync(fd); events.push(`sync:${handles.get(fd)}`); });
  const file = await publish(mode, "a"), log = deployResourceLogPath(file);
  const logWrite = events.indexOf(`write:${log}`);
  for (const name of mode === "home" ? [path.join(path.dirname(file), "spawnfile-report.json"), file] : [file]) {
    const fileSync = events.findIndex((event) => event.startsWith(`sync:${name}.`) && event.endsWith(".tmp"));
    const renamed = events.indexOf(`rename:${name}`);
    const dirSync = events.findIndex((event, index) => index > renamed && event === `sync:${path.dirname(name)}`);
    expect(fileSync).toBeGreaterThanOrEqual(0);
    expect(fileSync).toBeLessThan(renamed);
    expect(renamed).toBeLessThan(dirSync);
    expect(dirSync).toBeLessThan(logWrite);
  }
  expect(events.indexOf(`sync:${log}`)).toBeGreaterThan(logWrite);
});

it.each(["project", "home"])("%s keeps a renamed record recoverable when its directory fsync fails, without logging ahead", async (mode) => {
  const file = await publish(mode, "a");
  const rename = asyncFs.rename, open = asyncFs.open;
  let renamed = false;
  vi.spyOn(asyncFs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (String(to) === file) renamed = true;
  });
  vi.spyOn(asyncFs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) !== path.dirname(file)) return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === "sync" && renamed) return async () => { throw new Error("directory fsync failed"); };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await expect(publish(mode, "b")).rejects.toThrow("is published, but recording failed");
  expect(readDeployResources(file).entries).toHaveLength(1);
  expect((await readDeploymentRecord(file)).resource_snapshot!.resources[0]).toMatchObject({ commit: "b".repeat(40) });
  vi.restoreAllMocks();
  await publish(mode, "c");
  expect(readDeployResources(file).entries.map((entry) => entry.resources[0])).toMatchObject([
    { commit: "a".repeat(40) }, { commit: "b".repeat(40) }, { commit: "c".repeat(40) }
  ]);
});
