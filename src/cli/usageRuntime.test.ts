import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "../deployment/index.js";
import type { RuntimeUsageOperations } from "../runtime/operations.js";
import * as registry from "../runtime/registry.js";
import { REPORT_FILENAME } from "../shared/index.js";
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

  exec.mockClear();
  expect(await collectOrganizationUsage({ outputDirectory: root }, {
    ...handlers, listDeploymentRecords: async () => [{ path: "", record: { ...record, compile_fingerprint: "sf1:stale" } }]
  })).toMatchObject({ records: [], unreadableUnits: [] });
  expect(exec).not.toHaveBeenCalled();
});
