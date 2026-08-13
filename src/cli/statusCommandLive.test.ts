import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrganizationView } from "../compiler/index.js";

import {
  inspectDeployments,
  recoverContextDeployments,
  resolveDeploymentRecords,
  resolveStatusAuthValues,
  runHomeDeploymentStatus,
  type LoadedDeploymentRecord
} from "./statusCommandLive.js";

const originalHome = process.env.SPAWNFILE_HOME;
const roots: string[] = [];

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

const createRecord = (
  name: string,
  authProfile: string | null = null
): LoadedDeploymentRecord => ({
  path: `/tmp/${name}.json`,
  record: {
    auth_profile: authProfile,
    compile_fingerprint: "sf1:test",
    created_at: "2026-08-09T00:00:00.000Z",
    manager: "docker",
    name,
    output_directory: "/tmp/output",
    source: { kind: "project", root: "/tmp/Spawnfile" },
    target: {
      endpoint_fingerprint: `sha256:${"a".repeat(32)}`,
      kind: "context",
      name: "default"
    },
    units: [],
    version: "spawnfile.deployment.v2"
  }
});

const createView = (): OrganizationView => ({
  contexts: [],
  diagnostics: [],
  inputPath: "/tmp/Spawnfile",
  networks: [],
  projectRoot: "/tmp",
  root: {
    children: [],
    displayName: "assistant",
    id: "agent:assistant",
    kind: "agent",
    name: "assistant",
    runtimeName: "pi",
    slug: "assistant",
    source: "/tmp/Spawnfile"
  },
  runtimes: [{ name: "pi", nodeIds: ["agent:assistant"] }]
});

const setupHomeRecords = async (names: string[]) => {
  const { writeHomeDeployment } = await import("../deployment/index.js");
  const { buildDistributionReport } = await import("../distribution/index.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "status-live-records-"));
  roots.push(home);
  process.env.SPAWNFILE_HOME = home;
  const report = buildDistributionReport({
    envVariables: [],
    generatedAt: "2026-08-09T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: {},
    moltnetNetworks: [],
    organization: {
      agents: [{ id: "agent:assistant", name: "assistant", runtime: "pi", teams: [] }],
      project: "status-test",
      teams: []
    },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: []
  });
  const paths = [];
  for (const name of names) {
    paths.push(await writeHomeDeployment({
      auth_profile: null,
      compile_fingerprint: report.compile_fingerprint,
      created_at: "2026-08-09T00:00:00.000Z",
      manager: "docker",
      name,
      output_directory: null,
      source: { kind: "project", root: `/tmp/${name}/Spawnfile` },
      target: {
        endpoint_fingerprint: `sha256:${"a".repeat(32)}`,
        kind: "context",
        name: "default"
      },
      units: [{
        container_id: null,
        container_name: `${name}-container`,
        contains: [{ id: "agent:assistant", kind: "agent" }],
        id: `${name}-container`,
        image_id: null,
        image_tag: `example/${name}:latest`,
        kind: "container",
        runtime_instances: []
      }],
      version: "spawnfile.deployment.v2"
    }, report));
  }
  return { home, paths };
};

describe("status live helpers", () => {
  it("reports empty and ambiguous deployment selections explicitly", () => {
    expect(resolveDeploymentRecords([], { deployment: "missing" })).toMatchObject({
      error: expect.stringContaining("Valid deployments: none"),
      exitCode: 2
    });
    expect(resolveDeploymentRecords(
      [createRecord("zeta"), createRecord("alpha")],
      { live: true }
    )).toMatchObject({
      error: expect.stringContaining("alpha, zeta"),
      exitCode: 2
    });
    expect(resolveDeploymentRecords([createRecord("alpha")], {})).toHaveLength(1);
  });

  it("skips static inspection and uses the injected live inspector", async () => {
    const records = [createRecord("alpha")];
    await expect(inspectDeployments(records, {}, {}, undefined)).resolves.toEqual(new Map());
    const inspectDockerDeployment = vi.fn(async () => new Map());
    const inspections = await inspectDeployments(
      records,
      { inspectDockerDeployment },
      { dockerCommand: "docker-safe", live: true },
      123
    );
    expect(inspections).toEqual(new Map([["alpha", new Map()]]));
    expect(inspectDockerDeployment).toHaveBeenCalledWith(records[0]!.record, {
      dockerCommand: "docker-safe",
      timeoutMs: 123
    });
  });

  it("deduplicates profile reads and ignores unavailable profile values", async () => {
    const records = [
      createRecord("one", "ops"),
      createRecord("two", "ops"),
      createRecord("three", "missing"),
      createRecord("four", ""),
      createRecord("five")
    ];
    const buildOrganizationView = vi.fn(async () => createView());
    await expect(resolveStatusAuthValues(records, { buildOrganizationView })).resolves.toEqual({});
    const requireAuthProfile = vi.fn(async (name: string) => {
      if (name === "missing") throw new Error("not found");
      return {
        authHome: "/tmp/auth",
        env: { TOKEN: name },
        imports: {},
        name,
        profileDirectory: `/tmp/auth/${name}`,
        profilePath: `/tmp/auth/${name}/profile.json`,
        version: 1 as const
      };
    });
    await expect(resolveStatusAuthValues(records, { buildOrganizationView, requireAuthProfile }))
      .resolves.toEqual({ TOKEN: "ops" });
    expect(requireAuthProfile).toHaveBeenCalledTimes(2);
  });

  it("recovers context records without runtime instances from a missing report", async () => {
    const recoverDockerDeploymentRecords = vi.fn(async () => [createRecord("remote")]);
    const result = await recoverContextDeployments({
      handlers: { recoverDockerDeploymentRecords },
      loadedReport: {
        failure: { exitCode: 2, message: "missing" },
        kind: "failure",
        reportPath: "/tmp/output/spawnfile-report.json"
      },
      options: { context: "remote", dockerCommand: "docker-safe" },
      outputDirectory: "/tmp/output",
      projectLabel: "project",
      sourceRoot: "/tmp/Spawnfile",
      timeoutMs: 500,
      view: createView()
    });
    expect(result).toHaveLength(1);
    expect(recoverDockerDeploymentRecords).toHaveBeenCalledWith(expect.objectContaining({
      contains: [{ id: "agent:assistant", kind: "agent" }],
      runtimeInstanceIds: []
    }));
  });

  it("reports an empty home deployment store without needing a project view", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "status-live-home-"));
    roots.push(home);
    process.env.SPAWNFILE_HOME = home;
    const buildOrganizationView = vi.fn(async () => createView());
    await expect(runHomeDeploymentStatus(
      {},
      { buildOrganizationView },
      "pretty",
      undefined
    )).resolves.toMatchObject({
      error: "No image deployments found in the home store",
      exitCode: 2
    });
    expect(buildOrganizationView).not.toHaveBeenCalled();
  });

  it("requires an explicit name for multiple home records", async () => {
    await setupHomeRecords(["zeta", "alpha"]);
    await expect(runHomeDeploymentStatus(
      {},
      { buildOrganizationView: vi.fn(async () => createView()) },
      "pretty",
      undefined
    )).resolves.toMatchObject({
      error: expect.stringContaining("alpha, zeta"),
      exitCode: 2
    });
  });

  it("reports malformed cached home reports and home-store read failures", async () => {
    const { paths } = await setupHomeRecords(["broken"]);
    await writeFile(paths[0]!.reportPath, "{", "utf8");
    await expect(runHomeDeploymentStatus(
      { deployment: "broken" },
      { buildOrganizationView: vi.fn(async () => createView()) },
      "pretty",
      undefined
    )).resolves.toMatchObject({
      error: expect.stringContaining("is not valid JSON"),
      exitCode: 2
    });

    const hostileHome = path.join(roots[0]!, "not-a-directory");
    await writeFile(hostileHome, "file", "utf8");
    process.env.SPAWNFILE_HOME = hostileHome;
    await expect(runHomeDeploymentStatus(
      {},
      { buildOrganizationView: vi.fn(async () => createView()) },
      "pretty",
      undefined
    )).resolves.toMatchObject({
      error: expect.stringContaining("Unable to read home deployments directory"),
      exitCode: 2
    });
  });

  it("collects optional home log observations", async () => {
    await setupHomeRecords(["live"]);
    const collectDeploymentLogObservations = vi.fn(async () => []);
    const result = await runHomeDeploymentStatus(
      { deployment: "live", live: true, logs: true },
      {
        buildOrganizationView: vi.fn(async () => createView()),
        collectDeploymentLogObservations,
        collectMoltnetProbeObservations: vi.fn(async () => []),
        collectRuntimeProbeObservations: vi.fn(async () => []),
        inspectDockerDeployment: vi.fn(async () => new Map())
      },
      "json",
      250
    );
    expect([0, 1]).toContain(result.exitCode);
    expect(collectDeploymentLogObservations).toHaveBeenCalled();
  });
});
