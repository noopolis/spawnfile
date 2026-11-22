import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "../deployment/index.js";
import type { RuntimeUsageOperations } from "../runtime/operations.js";
import * as registry from "../runtime/registry.js";
import { REPORT_FILENAME } from "../shared/index.js";
import { executeUsageCommand } from "./usageCommand.js";
import { collectOrganizationUsage } from "./usageCommandLive.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const deployment = (root: string): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:0123456789ab",
  created_at: new Date().toISOString(),
  manager: "docker",
  name: "sample",
  output_directory: root,
  source: { kind: "project", root },
  target: { kind: "host", value: "unix:///var/run/docker.sock" },
  units: [{
    container_id: "container-1",
    container_name: "sample",
    contains: [{ id: "worker", kind: "agent" }],
    id: "unit-1",
    image_id: null,
    image_tag: "sample:local",
    kind: "container",
    runtime_instances: ["agent-worker"]
  }],
  version: "spawnfile.deployment.v2"
});

it("reads the runtime selected by the matching report with its own parser and buffer bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-usage-runtime-"));
  roots.push(root);
  const record = deployment(root);
  const runtime = "test-runtime";
  await writeFile(path.join(root, REPORT_FILENAME), JSON.stringify({
    compile_fingerprint: record.compile_fingerprint,
    nodes: [],
    container: { runtime_instances: [{ runtime, id: "agent-worker" }] }
  }));

  const parse = vi.fn(() => []);
  const usage: RuntimeUsageOperations = {
    livePaths: { filePath: "/state/tokens", rotatedFilePath: "/state/older" },
    exportedPaths: { filePath: "raw/test/tokens", rotatedFilePath: "raw/test/older" },
    volumePaths: { filePath: "tokens", rotatedFilePath: "older" },
    mountId: "external-usage",
    maxReadBytes: 72_000,
    parse
  };
  const registered = registry.getRuntimeOperations;
  vi.spyOn(registry, "getRuntimeOperations").mockImplementation((name) =>
    name === runtime ? { usage } : registered(name));
  const exec = vi.fn(async ([, file]: string[]) => ({ stderr: "", stdout: `native:${file}` }));
  const createGateway = vi.fn(() => ({ exec, httpGet: vi.fn(), inspectUnit: vi.fn() }));
  const list = async () => [{ path: path.join(root, "record.json"), record }];
  const inspect = vi.fn(async () => new Map([["unit-1", { running: true }]]));
  const handlers = {
    createDockerProbeGateway: createGateway,
    inspectDockerDeployment: inspect as never,
    listDeploymentRecords: list
  };

  expect(await collectOrganizationUsage({ outputDirectory: root }, handlers))
    .toMatchObject({ records: [], unreadableUnits: [] });
  expect(createGateway).toHaveBeenCalledWith(record, record.units[0], expect.objectContaining({ maxBufferBytes: 72_000 }));
  expect(exec.mock.calls).toEqual([[["cat", "/state/older"]], [["cat", "/state/tokens"]]]);
  expect(parse.mock.calls).toEqual([["native:/state/older"], ["native:/state/tokens"]]);

  const absent = () => Object.assign(new Error("No such file or directory"), { code: 1 });
  exec.mockImplementation(async () => { throw absent(); });
  const missing = await executeUsageCommand(root, { out: root }, handlers);
  expect(missing.exitCode).toBe(0);
  expect(missing.output).toContain("coverage PARTIAL");
  expect(missing.output).toContain("no ledger generation is present");
  expect(missing.output).not.toMatch(/\$\d/u);

  exec.mockImplementation(async ([, file]) => {
    if (file === "/state/older") throw absent();
    return { stderr: "", stdout: "" };
  });
  const empty = await executeUsageCommand(root, { json: true, out: root }, handlers);
  expect(empty.exitCode).toBe(0);
  expect(JSON.parse(empty.output!)).toMatchObject({ byEngine: [], unreadableUnits: [] });

  exec.mockClear();
  const unmetered = {
    ...handlers,
    listDeploymentRecords: async () => [{ path: "", record: { ...record, compile_fingerprint: "sf1:stale" } }]
  };
  const unknown = await executeUsageCommand(root, { json: true, out: root }, unmetered);
  expect(unknown.exitCode).toBe(0);
  expect(JSON.parse(unknown.output!)).toMatchObject({
    coverage: { partial: true, unreadableUnitCount: 1 },
    unreadableUnits: [{ reason: "meter_unavailable", unitId: "unit-1" }]
  });
  expect(exec).not.toHaveBeenCalled();
});

it("reports a missing export for an unmetered deployment and accepts a readable empty generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-usage-export-meter-"));
  roots.push(root);
  const indexDir = path.join(root, "spawnfile");
  await mkdir(indexDir);
  await writeFile(path.join(indexDir, "export-index.json"), JSON.stringify({
    deployment: "sample",
    exported_at: new Date().toISOString(),
    files: [],
    run_id: "run-empty",
    version: "spawnfile.export-index.v1"
  }));
  const exec = vi.fn();
  const handlers = {
    createDockerProbeGateway: exec,
    listDeploymentRecords: async () => [{ path: "", record: deployment(root) }]
  };
  const options = { exported: root, json: true, out: root };
  const missing = await executeUsageCommand(root, options, handlers);
  expect(missing.exitCode).toBe(0);
  expect(JSON.parse(missing.output!)).toMatchObject({
    coverage: { partial: true, unreadableUnitCount: 1 },
    unreadableUnits: [{ detail: "No usage ledger is present in this export" }]
  });

  const daimonUsage = registry.getRuntimeOperations("daimon")!.usage!;
  const rotated = path.join(root, daimonUsage.exportedPaths.rotatedFilePath);
  await mkdir(path.dirname(rotated), { recursive: true });
  await writeFile(rotated, "");
  const empty = await executeUsageCommand(root, options, handlers);
  expect(empty.exitCode).toBe(0);
  expect(JSON.parse(empty.output!)).toMatchObject({ byEngine: [], unreadableUnits: [] });
  expect(exec).not.toHaveBeenCalled();
});
