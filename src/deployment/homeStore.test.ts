import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDistributionReport } from "../distribution/index.js";
import { removeDirectory } from "../filesystem/index.js";

import {
  acquireHomeDeploymentLock,
  homeDeploymentExists,
  listHomeDeploymentRecords,
  readHomeDeploymentRecord,
  readHomeDeploymentReport,
  writeHomeDeployment
} from "./homeStore.js";
import type { DeploymentRecord } from "./record.js";

const previousHome = process.env.SPAWNFILE_HOME;
let homeDirectory: string;

beforeEach(async () => {
  homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-home-test-"));
  process.env.SPAWNFILE_HOME = homeDirectory;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousHome;
  }
  await removeDirectory(homeDirectory).catch(() => undefined);
});

const record = (name: string): DeploymentRecord => ({
  auth_profile: "me",
  compile_fingerprint: "sf1:abc123",
  created_at: "2026-06-13T00:00:00.000Z",
  manager: "docker",
  name,
  output_directory: null,
  source: { digest: "sha256:feed", kind: "image", ref: "you/org:1.0.0" },
  target: {
    endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
    kind: "context",
    name: "default"
  },
  units: [
    {
      container_id: "c1",
      container_name: "spawnfile-org",
      contains: [{ id: "agent:a", kind: "agent" }],
      id: `${name}-container`,
      image_id: "i1",
      image_tag: "you/org:1.0.0",
      kind: "container",
      runtime_instances: ["picoclaw-a"]
    }
  ],
  version: "spawnfile.deployment.v2"
});

const report = () =>
  buildDistributionReport({
    envVariables: [],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: {},
    moltnetNetworks: [],
    organization: { agents: [], project: "org", teams: [] },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: []
  });

describe("home store", () => {
  it("writes and reads back a record and cached report", async () => {
    await writeHomeDeployment(record("research"), report());
    const loaded = await readHomeDeploymentRecord("research");
    expect(loaded.name).toBe("research");
    expect(loaded.source.kind).toBe("image");
    const cached = JSON.parse(await readHomeDeploymentReport("research"));
    expect(cached.version).toBe("spawnfile.distribution-report.v1");
  });

  it("reports existence and lists records", async () => {
    expect(await homeDeploymentExists("research")).toBe(false);
    await writeHomeDeployment(record("research"), report());
    await writeHomeDeployment(record("staging"), report());
    expect(await homeDeploymentExists("research")).toBe(true);
    const names = (await listHomeDeploymentRecords()).map((entry) => entry.record.name);
    expect(names).toEqual(["research", "staging"]);
  });

  it("returns an empty list when the store is absent", async () => {
    await removeDirectory(homeDirectory);
    expect(await listHomeDeploymentRecords()).toEqual([]);
  });

  it("grants an exclusive deployment lock and blocks a second acquire", async () => {
    const release = await acquireHomeDeploymentLock("research");
    await expect(acquireHomeDeploymentLock("research")).rejects.toThrow(/already being modified/);
    await release();
    // After release the lock can be acquired again.
    const release2 = await acquireHomeDeploymentLock("research");
    await release2();
  });

  it("reclaims a stale lock left by a dead process", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const lockDir = path.join(homeDirectory, "deployments", "research");
    await mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, ".lock");
    // A lock owned by a pid that is not running (crashed deploy) must not block forever.
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_646 }));
    const release = await acquireHomeDeploymentLock("research");
    // Reclamation (not a no-op bypass): the lock is now owned by THIS process.
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(owner.pid).toBe(process.pid);
    await release();
  });
});
