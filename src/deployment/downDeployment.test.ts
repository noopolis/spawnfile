import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./organizationHandoffAuthorityStore.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./organizationHandoffAuthorityStore.js")>(),
  initializeOrganizationHandoffAuthorityStore: vi.fn()
}));

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import { REPORT_FILENAME } from "../shared/index.js";

import { downDeployment } from "./downDeployment.js";
import { createOrganizationHandoff, parseCanonicalSha256Digest } from "./organizationHandoffTypes.js";
import {
  initializeOrganizationHandoffAuthorityStore,
  type OrganizationHandoffAuthorityStore
} from "./organizationHandoffAuthorityStore.js";
import { readDeploymentRecord, writeDeploymentRecord, type DeploymentRecord } from "./record.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
  vi.mocked(initializeOrganizationHandoffAuthorityStore).mockReset();
});

const createRecord = (overrides: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:abc123",
  created_at: "2026-07-11T00:00:00.000Z",
  manager: "docker",
  name: "default",
  output_directory: "/project/.spawn",
  run_id: "run-abc123",
  source: { kind: "project", root: "/project" },
  target: { endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef", kind: "context", name: "default" },
  units: [
    {
      container_id: "container-123",
      container_name: "spawnfile-project",
      contains: [{ id: "agent:eleanor", kind: "agent" }],
      id: "default-container",
      image_id: "image-123",
      image_tag: "spawnfile-project:latest",
      kind: "container",
      runtime_instances: ["agent-eleanor"]
    }
  ],
  version: "spawnfile.deployment.v2",
  ...overrides
});

const handoff = createOrganizationHandoff("run-abc123", {
  bindingDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`),
  networkAttachmentHandle: `opaque_${"b".repeat(16)}` as never,
  selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"c".repeat(64)}`)
});
const handoffHandle = `opaque_${"d".repeat(16)}` as never;
const exported = {
  exported_at: "2026-07-11T00:00:00.000Z",
  path: "/somewhere/export-index.json",
  run_id: "run-abc123"
} as const;
const deploymentHandle = (value: unknown): string =>
  value !== null && typeof value === "object" && typeof (value as { deployment_handle?: unknown }).deployment_handle === "string"
    ? (value as { deployment_handle: string }).deployment_handle
    : "invalid";

const fakeAuthority = (events: string[], close: () => Promise<void> = async () => undefined, dispose: () => Promise<void> = async () => undefined): OrganizationHandoffAuthorityStore => ({
  begin: async () => { throw new Error("not used"); },
  close: async (input) => {
    events.push(`close:${String(input.organizationHandoffHandle)}:${deploymentHandle(input.expectedHandoff)}`);
    await close();
  },
  dispose: async () => { events.push("dispose"); await dispose(); },
  finalize: async () => { throw new Error("not used"); },
  observeDockerMutation: async () => { throw new Error("not used"); },
  readDockerMutation: async () => null,
  reserve: async () => { throw new Error("not used"); },
  resolver: { resolve: async () => { throw new Error("not used"); } }
});

const createReportWithVolumes = (): CompileReport => ({
  container: {
    dockerfile: "container/Dockerfile",
    entrypoint: "container/entrypoint",
    env_example: "container/.env.example",
    model_secrets_required: [],
    persistent_mounts: [
      {
        id: "moltnet-office_lab-causal",
        mount_path: "/var/lib/spawnfile/moltnet/servers/root-office_lab/causal",
        reason: "managed Moltnet causal event log for office_lab",
        volume_name: "spawnfile-project-moltnet-causal-abc123"
      },
      {
        id: "memory-office-recall",
        mount_path: "/var/lib/spawnfile/memory/office-recall",
        reason: "durable memory stores",
        volume_name: "spawnfile-project-memory-office-recall-abc123"
      }
    ],
    ports: [],
    runtime_homes: [],
    runtime_instances: [],
    runtime_secrets_required: [],
    runtimes_installed: [],
    secrets_required: []
  },
  diagnostics: [],
  nodes: [],
  root: "/project",
  spawnfile_version: "0.1"
});

/** A combined fake covering both artifactsExport's Docker calls (inspect/create/cp) — hit
 * only when `--export-to` triggers an auto-export — and downDeployment's own teardown
 * calls (rm/volume rm). Same shape as artifactsExport.test.ts's own fake, extended. */
const createFakeExecFile = (options: {
  failRemoveContainer?: boolean;
  failRemoveVolume?: string;
} = {}) => async (_file: string, args: string[]): Promise<{ stderr: string; stdout: string }> => {
  if (args.includes("inspect")) {
    return { stderr: "", stdout: "[]" };
  }
  if (args.includes("volume") && args.includes("rm")) {
    const volumeName = args[args.length - 1]!;
    if (options.failRemoveVolume === volumeName) {
      throw new Error(`unable to remove volume ${volumeName}: in use`);
    }
    return { stderr: "", stdout: "" };
  }
  if (args.includes("rm")) {
    if (options.failRemoveContainer) {
      throw new Error("cannot remove container: still running");
    }
    return { stderr: "", stdout: "" };
  }
  if (args.includes("cp")) {
    return { stderr: "", stdout: "" };
  }
  throw new Error(`unexpected docker args: ${JSON.stringify(args)}`);
};

const setupCompiledOutput = async (
  recordOverrides: Partial<DeploymentRecord> = {}
): Promise<string> => {
  const compiledOutputDirectory = await createTempDirectory("spawnfile-down-compiled-");
  await writeDeploymentRecord(compiledOutputDirectory, createRecord(recordOverrides));
  await writeUtf8File(
    path.join(compiledOutputDirectory, REPORT_FILENAME),
    JSON.stringify(createReportWithVolumes())
  );
  return compiledOutputDirectory;
};

describe("downDeployment", () => {
  it("leaves ordinary records on the existing down path without initializing authority", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({ export_index: exported });

    await expect(downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile()
    })).resolves.toMatchObject({ units_stopped: ["default-container"] });

    expect(initializeOrganizationHandoffAuthorityStore).not.toHaveBeenCalled();
  });

  it("fails closed for a legacy public handoff without a private handle before authority or Docker", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: exported,
      organization_handoff: handoff
    });
    let dockerCalls = 0;

    await expect(downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: async () => { dockerCalls += 1; return { stderr: "", stdout: "" }; }
    })).rejects.toThrow("authority is incomplete");

    expect(initializeOrganizationHandoffAuthorityStore).not.toHaveBeenCalled();
    expect(dockerCalls).toBe(0);
    expect((await readDeploymentRecord(path.join(compiledOutputDirectory, "deployments", "default.json"))).organization_handoff_handle).toBeUndefined();
  });

  it("closes the exact stored private handle and disposes before Docker teardown", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: exported,
      organization_handoff: handoff,
      organization_handoff_handle: handoffHandle
    });
    const events: string[] = [];
    vi.mocked(initializeOrganizationHandoffAuthorityStore).mockImplementation(async () => {
      events.push("initialize");
      return fakeAuthority(events);
    });

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: async (_file, args) => {
        events.push(`docker:${args.join(" ")}`);
        return { stderr: "", stdout: "" };
      }
    });

    expect(events).toEqual([
      "initialize",
      `close:${handoffHandle}:${handoff.deployment_handle}`,
      "dispose",
      "docker:--context default rm -f container-123"
    ]);
    expect(events).not.toContain(`close:${handoff.deployment_handle}:${handoff.deployment_handle}`);
    expect(JSON.stringify(receipt)).not.toContain(handoffHandle);
    expect(JSON.stringify(receipt)).not.toContain(handoff.deployment_handle);
  });

  it("uses the direct re-read record after --export-to before closing its private handle", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      organization_handoff: handoff,
      organization_handoff_handle: handoffHandle
    });
    const exportDirectory = await createTempDirectory("spawnfile-down-export-");
    const events: string[] = [];
    vi.mocked(initializeOrganizationHandoffAuthorityStore).mockResolvedValue(fakeAuthority(events));

    await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      exportTo: exportDirectory,
      execFile: async (_file, args) => {
        if (args.includes("inspect")) return { stderr: "", stdout: "[]" };
        if (args.includes("cp")) return { stderr: "", stdout: "" };
        if (args.includes("rm")) { events.push("docker"); return { stderr: "", stdout: "" }; }
        throw new Error("unexpected docker invocation");
      }
    });

    expect(events).toEqual([`close:${handoffHandle}:${handoff.deployment_handle}`, "dispose", "docker"]);
  });

  it.each(["corrupt private authority", "authority path changed during close"])("fails closed without Docker when the authority store reports %s", async (reason) => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: exported,
      organization_handoff: handoff,
      organization_handoff_handle: handoffHandle
    });
    const events: string[] = [];
    vi.mocked(initializeOrganizationHandoffAuthorityStore).mockResolvedValue(fakeAuthority(
      events,
      async () => { throw new Error(`${reason}: ${handoffHandle}`); }
    ));
    let dockerCalls = 0;

    const error = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: async () => { dockerCalls += 1; return { stderr: "", stdout: "" }; }
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Unable to close organization handoff authority");
    expect(String(error)).not.toContain(handoffHandle);
    expect(events).toEqual([`close:${handoffHandle}:${handoff.deployment_handle}`, "dispose"]);
    expect(dockerCalls).toBe(0);
  });

  it("keeps authority close retryable across idempotent down retries", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: exported,
      organization_handoff: handoff,
      organization_handoff_handle: handoffHandle
    });
    const events: string[] = [];
    vi.mocked(initializeOrganizationHandoffAuthorityStore).mockImplementation(async () => fakeAuthority(events));

    await downDeployment({ compiledOutputDirectory, deploymentName: "default", execFile: createFakeExecFile() });
    await downDeployment({ compiledOutputDirectory, deploymentName: "default", execFile: createFakeExecFile() });

    expect(events).toEqual([
      `close:${handoffHandle}:${handoff.deployment_handle}`,
      "dispose",
      `close:${handoffHandle}:${handoff.deployment_handle}`,
      "dispose"
    ]);
  });

  it("re-closes the same direct handle after an ambiguous Docker teardown and completes a no-such-container retry", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: exported,
      organization_handoff: handoff,
      organization_handoff_handle: handoffHandle
    });
    const events: string[] = [];
    vi.mocked(initializeOrganizationHandoffAuthorityStore).mockImplementation(async () => fakeAuthority(events));

    const first = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: async () => {
        events.push("docker:connection-lost-after-mutation");
        throw new Error("connection lost after Docker accepted the removal");
      }
    });
    expect(first.errors).toHaveLength(1);

    const second = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: async () => {
        events.push("docker:not-found-on-retry");
        throw { stderr: "Error: No such container: container-123" };
      }
    });
    expect(second.units_stopped).toEqual(["default-container"]);
    expect(events).toEqual([
      `close:${handoffHandle}:${handoff.deployment_handle}`, "dispose", "docker:connection-lost-after-mutation",
      `close:${handoffHandle}:${handoff.deployment_handle}`, "dispose", "docker:not-found-on-retry"
    ]);
    const directRecord = await readDeploymentRecord(
      path.join(compiledOutputDirectory, "deployments", "default.json")
    );
    expect(directRecord.organization_handoff_handle).toBe(handoffHandle);
    expect(directRecord.organization_handoff?.deployment_handle).not.toBe(handoffHandle);
  });

  it("refuses to tear down a run with no export-index, and does not remove the container", async () => {
    const compiledOutputDirectory = await setupCompiledOutput();

    await expect(
      downDeployment({
        compiledOutputDirectory,
        deploymentName: "default",
        execFile: createFakeExecFile()
      })
    ).rejects.toThrow(/has no export-index/);

    // Guard runs before any teardown: the fake would have thrown on an unexpected call if
    // rm had actually been attempted, but assert the record is untouched too.
    const record = await readDeploymentRecord(
      path.join(compiledOutputDirectory, "deployments", "default.json")
    );
    expect(record.export_index).toBeUndefined();
  });

  it("--force proceeds without an export-index and tears the container down (volumes retained by default)", async () => {
    const compiledOutputDirectory = await setupCompiledOutput();

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile(),
      force: true
    });

    expect(receipt.version).toBe("spawnfile.down-receipt.v1");
    expect(receipt.deployment).toBe("default");
    expect(receipt.units_stopped).toEqual(["default-container"]);
    expect(receipt.errors).toEqual([]);
    expect(receipt.retained_volumes).toEqual([
      "spawnfile-project-memory-office-recall-abc123",
      "spawnfile-project-moltnet-causal-abc123"
    ]);
  });

  it("--export-to auto-exports (stamping export_index) then tears down, clearing the guard", async () => {
    const compiledOutputDirectory = await setupCompiledOutput();
    const exportDirectory = await createTempDirectory("spawnfile-down-export-");

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile(),
      exportTo: exportDirectory
    });

    expect(receipt.units_stopped).toEqual(["default-container"]);
    expect(receipt.errors).toEqual([]);

    const indexOnDisk = JSON.parse(
      await readFile(path.join(exportDirectory, "spawnfile", "export-index.json"), "utf8")
    );
    expect(indexOnDisk.version).toBe("spawnfile.export-index.v1");

    const record = await readDeploymentRecord(
      path.join(compiledOutputDirectory, "deployments", "default.json")
    );
    expect(record.export_index).toMatchObject({ run_id: "run-abc123" });
  });

  it("tears down without exporting when the record already carries an export_index (already exported earlier)", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: { exported_at: "2026-07-11T00:00:00.000Z", path: "/somewhere/export-index.json", run_id: "run-abc123" }
    });

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile()
    });

    expect(receipt.units_stopped).toEqual(["default-container"]);
    expect(receipt.errors).toEqual([]);
  });

  it("collects a partial container-removal failure into errors instead of throwing", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: { exported_at: "2026-07-11T00:00:00.000Z", path: "/somewhere/export-index.json", run_id: "run-abc123" }
    });

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile({ failRemoveContainer: true })
    });

    expect(receipt.units_stopped).toEqual([]);
    expect(receipt.errors).toHaveLength(1);
    expect(receipt.errors[0]).toMatch(/unable to remove container/);
  });

  it("--volumes removes named volumes, collecting a failed one into both retained_volumes and errors", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: { exported_at: "2026-07-11T00:00:00.000Z", path: "/somewhere/export-index.json", run_id: "run-abc123" }
    });

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile({ failRemoveVolume: "spawnfile-project-memory-office-recall-abc123" }),
      removeVolumes: true
    });

    expect(receipt.units_stopped).toEqual(["default-container"]);
    expect(receipt.retained_volumes).toEqual(["spawnfile-project-memory-office-recall-abc123"]);
    expect(receipt.errors).toEqual([
      "unable to remove volume spawnfile-project-memory-office-recall-abc123: unable to remove volume spawnfile-project-memory-office-recall-abc123: in use"
    ]);
  });

  it("is idempotent: a second down call on an already-torn-down container still succeeds", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: { exported_at: "2026-07-11T00:00:00.000Z", path: "/somewhere/export-index.json", run_id: "run-abc123" }
    });
    const alreadyGoneExecFile = async (
      _file: string,
      args: string[]
    ): Promise<{ stderr: string; stdout: string }> => {
      if (args.includes("rm") && !args.includes("volume")) {
        throw { stderr: "Error: No such container: spawnfile-project" };
      }
      return { stderr: "", stdout: "" };
    };

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: alreadyGoneExecFile
    });

    expect(receipt.units_stopped).toEqual(["default-container"]);
    expect(receipt.errors).toEqual([]);
  });

  it("tears down with no volumes to report when the compile report is absent (record only)", async () => {
    const compiledOutputDirectory = await createTempDirectory("spawnfile-down-compiled-");
    await writeDeploymentRecord(compiledOutputDirectory, createRecord({
      export_index: { exported_at: "2026-07-11T00:00:00.000Z", path: "/somewhere/export-index.json", run_id: "run-abc123" }
    }));
    // Deliberately no spawnfile-report.json written.

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile()
    });

    expect(receipt.units_stopped).toEqual(["default-container"]);
    expect(receipt.retained_volumes).toEqual([]);
    expect(receipt.errors).toEqual([]);
  });

  it("flags a unit with no recorded container id or name instead of attempting to remove it", async () => {
    const compiledOutputDirectory = await setupCompiledOutput({
      export_index: { exported_at: "2026-07-11T00:00:00.000Z", path: "/somewhere/export-index.json", run_id: "run-abc123" },
      units: [
        {
          container_id: null,
          container_name: null,
          contains: [{ id: "agent:eleanor", kind: "agent" }],
          id: "default-container",
          image_id: null,
          image_tag: "spawnfile-project:latest",
          kind: "container",
          runtime_instances: ["agent-eleanor"]
        }
      ]
    });

    const receipt = await downDeployment({
      compiledOutputDirectory,
      deploymentName: "default",
      execFile: createFakeExecFile()
    });

    expect(receipt.units_stopped).toEqual([]);
    expect(receipt.errors).toEqual([
      "unit default-container has no recorded container id or name; nothing to remove"
    ]);
  });
});
