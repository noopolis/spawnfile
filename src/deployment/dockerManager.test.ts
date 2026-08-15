import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./dockerInspect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dockerInspect.js")>();
  return { ...actual, inspectDockerDeployment: vi.fn() };
});

vi.mock("./dockerProbeGateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dockerProbeGateway.js")>();
  return { ...actual, createDockerProbeGateway: vi.fn() };
});

import { readUtf8File, removeDirectory } from "../filesystem/index.js";

import {
  createDockerDeploymentRecord,
  createDockerProjectLabel,
  probeDockerOrganizationReadiness,
  writeDockerDeploymentRecord,
  writeDockerDeploymentRecordForRun
} from "./dockerManager.js";
import { inspectDockerDeployment, type DockerUnitInspection } from "./dockerInspect.js";
import { createDockerProbeGateway } from "./dockerProbeGateway.js";
import type { OrganizationReadinessEvidence } from "../compiler/organizationReadyEvidence.js";
import type { DeploymentRecord } from "./record.js";
import type { RuntimeProbeGateway } from "../runtime/index.js";
import { createDockerDeploymentTarget } from "./target.js";
import { parseCanonicalSha256Digest } from "./organizationHandoffTypes.js";
import { parseOpaqueTargetHandle } from "../target/index.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-deployment-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const bindingBytes = JSON.stringify({ bindings: [], schema: "simfile.world-bindings.v1" });

const readinessEvidence: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:0123456789ab",
  compileVersion: "0.1",
  hasExternalMoltnet: false,
  networks: [{ id: "pitch", internalPort: 18789, mode: "managed", nodes: [], rooms: [] }],
  organizationMembers: [],
  projectLabel: "football",
  version: "spawnfile.organization-ready-evidence.v1",
  worldBindings: {
    artifactPath: "/spawnfile/world-bindings.json",
    assignments: [],
    digest: digest(bindingBytes),
    schema: "simfile.world-bindings.v1"
  }
};

const readinessRecord = (): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: readinessEvidence.compileFingerprint,
  created_at: "2026-07-22T00:00:00.000Z",
  manager: "docker",
  name: "football",
  output_directory: "/tmp/out",
  run_id: "run-123",
  source: { kind: "project", root: "/tmp/project" },
  target: { kind: "host", value: "unix:///var/run/docker.sock" },
  units: [{
    container_id: "opaque-container",
    container_name: "football",
    contains: [],
    id: "football-unit",
    image_id: "opaque-image",
    image_tag: "football:latest",
    kind: "container",
    runtime_instances: []
  }],
  version: "spawnfile.deployment.v2"
});

const readinessInspection = (): DockerUnitInspection => ({
  containerId: "opaque-container",
  drift: [],
  exists: true,
  exitCode: null,
  finishedAt: null,
  identity: {
    compileFingerprint: readinessEvidence.compileFingerprint,
    deployment: "football",
    project: "football",
    runId: "run-123",
    unit: "football-unit",
    version: "0.1"
  },
  imageId: "opaque-image",
  message: "running",
  restartCount: 0,
  running: true,
  severity: "ok",
  startedAt: null,
  status: "running",
  unitId: "football-unit"
});

describe("docker deployment manager foundations", () => {
  it("assembles a sanitized deployment record", () => {
    const record = createDockerDeploymentRecord({
      authProfileName: "prod",
      compileFingerprint: "sf1:abc123",
      containerName: "spawnfile-org",
      deploymentName: "prod",
      envFilePath: "./ops/prod.env",
      imageTag: "spawnfile-org",
      networkIds: ["pitch"],
      nodes: [
        { id: "team:root", kind: "team" },
        { id: "agent:worker", kind: "agent" }
      ],
      outputDirectory: "/tmp/project/.spawn",
      projectRoot: "/tmp/project/Spawnfile",
      runMetadata: {
        containerId: "container-123",
        imageId: "image-123"
      },
      runtimeInstanceIds: ["agent-worker"],
      target: createDockerDeploymentTarget({
        context: "prod",
        endpoint: "ssh://deploy@example"
      })
    });

    expect(record).toMatchObject({
      auth_profile: "prod",
      env_file: path.resolve("./ops/prod.env"),
      manager: "docker",
      name: "prod",
      units: [
        expect.objectContaining({
          container_id: "container-123",
          contains: expect.arrayContaining([{ id: "pitch", kind: "network" }]),
          image_id: "image-123",
          runtime_instances: ["agent-worker"]
        })
      ]
    });
    expect(record.target).not.toHaveProperty("endpoint");
  });

  it("derives identifier project labels from paths without preserving the path", () => {
    expect(createDockerProjectLabel("/Users/example/Documents/project/Spawnfile")).toBe("project");
  });

  it("prefers the manifest project name over the checkout directory when provided", () => {
    expect(
      createDockerProjectLabel("/Users/example/Documents/project/Spawnfile", "Research Cell")
    ).toBe("Research-Cell");
  });

  it("writes the assembled record", async () => {
    const outputDirectory = await createTempDirectory();
    const recordPath = await writeDockerDeploymentRecord({
      authProfileName: null,
      compileFingerprint: "sf1:abc123",
      containerName: "spawnfile-org",
      deploymentName: undefined,
      imageTag: "spawnfile-org",
      nodes: [],
      outputDirectory,
      projectRoot: "/tmp/project",
      runtimeInstanceIds: [],
      target: createDockerDeploymentTarget({
        context: "default",
        endpoint: "unix:///var/run/docker.sock"
      })
    });

    expect(recordPath).toBe(path.join(outputDirectory, "deployments", "default.json"));
    expect(await readUtf8File(recordPath)).toContain("\"name\": \"default\"");
  });

  it("writes a handoff only when its typed inputs and run id are complete", () => {
    const organizationHandoff = {
      bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
      networkAttachmentHandle: parseOpaqueTargetHandle("opaque_0123456789abcdef"),
      selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`)
    };
    const base = {
      authProfileName: null,
      compileFingerprint: "sf1:abc123",
      containerName: "spawnfile-org",
      imageTag: "spawnfile-org",
      nodes: [],
      outputDirectory: "/tmp/project/.spawn",
      projectRoot: "/tmp/project",
      runtimeInstanceIds: [],
      target: createDockerDeploymentTarget({ context: "default", endpoint: "unix:///var/run/docker.sock" })
    };

    expect(createDockerDeploymentRecord({ ...base, organizationHandoff })).not.toHaveProperty("organization_handoff");
    expect(createDockerDeploymentRecord({ ...base, runId: "run-2026-07-22" })).not.toHaveProperty("organization_handoff");
    expect(createDockerDeploymentRecord({ ...base, organizationHandoff, runId: "run-2026-07-22" }))
      .toHaveProperty("organization_handoff.deployment_handle");
  });

  it("refuses to write run records without a compile fingerprint", async () => {
    await expect(writeDockerDeploymentRecordForRun({
      authProfileName: null,
      imageTag: "spawnfile-org",
      invocation: {
        command: "docker",
        containerName: "spawnfile-org",
        deploymentName: "prod",
        detach: true
      },
      outputDirectory: "/tmp/out",
      report: {
        nodes: [],
        root: "/tmp/project"
      }
    })).rejects.toMatchObject({
      code: "validation_error"
    });
  });

  it("records each managed Moltnet network on the real detached writer path", async () => {
    const outputDirectory = await createTempDirectory();
    const recordPath = await writeDockerDeploymentRecordForRun({
      authProfileName: null,
      imageTag: "spawnfile-org",
      invocation: {
        command: "docker",
        containerName: "spawnfile-org",
        deploymentName: "football",
        detach: true,
        dockerHost: "unix:///var/run/docker.sock"
      },
      outputDirectory,
      report: {
        compile_fingerprint: "sf1:football",
        container: {
          moltnet: {
            server_plans: [
              { mode: "managed", network_id: "pitch" },
              { mode: "external", network_id: "spectators" }
            ]
          },
          runtime_instances: []
        },
        nodes: [],
        root: "/tmp/football"
      }
    });

    expect(recordPath).not.toBeNull();
    const record = JSON.parse(await readUtf8File(recordPath!)) as {
      units: Array<{ contains: Array<{ id: string; kind: string }> }>;
    };
    expect(record.units[0]?.contains).toContainEqual({
      id: "pitch",
      kind: "network"
    });
    expect(record.units[0]?.contains).not.toContainEqual({
      id: "spectators",
      kind: "network"
    });
  });

  it("passes a validated handoff through the detached writer exactly once", async () => {
    const outputDirectory = await createTempDirectory();
    const previousRunId = process.env.NOOPOLIS_RUN_ID;
    process.env.NOOPOLIS_RUN_ID = "run-from-host";
    try {
      const recordPath = await writeDockerDeploymentRecordForRun({
        authProfileName: null,
        imageTag: "football:latest",
        invocation: { command: "docker", containerName: "football", deploymentName: "football", detach: true,
          dockerHost: "unix:///var/run/docker.sock" },
        organizationHandoff: {
          bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
          networkAttachmentHandle: parseOpaqueTargetHandle("opaque_0123456789abcdef"),
          selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`)
        },
        outputDirectory,
        report: { compile_fingerprint: "sf1:football", nodes: [], root: "/tmp/football" }
      });
      const stored = JSON.parse(await readUtf8File(recordPath!)) as DeploymentRecord;
      expect(stored.organization_handoff).toMatchObject({
        binding_digest: `sha256:${"b".repeat(64)}`,
        network_attachment_handle: "opaque_0123456789abcdef",
        run_id: "run-from-host",
        selected_target_receipt_digest: `sha256:${"a".repeat(64)}`
      });
    } finally {
      if (previousRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
  });
});

describe("organization readiness manager seam", () => {
  it("inspects once, injects that exact inspection, and consumes identity through gateway.inspectUnit", async () => {
    const record = readinessRecord();
    const inspected = readinessInspection();
    const gatewayIdentity = readinessInspection();
    const requestPaths: string[] = [];
    gatewayIdentity.identity = { ...gatewayIdentity.identity!, runId: "wrong-run" };
    const gateway: RuntimeProbeGateway = {
      exec: vi.fn(async () => ({ stderr: "", stdout: bindingBytes })),
      httpGet: vi.fn(async (_port, requestPath) => ({
        body: (requestPaths.push(requestPath), "{}"),
        ok: true
      })),
      inspectUnit: vi.fn(async () => gatewayIdentity)
    };
    vi.mocked(inspectDockerDeployment).mockResolvedValue(new Map([[record.units[0]!.id, inspected]]));
    vi.mocked(createDockerProbeGateway).mockReturnValue(gateway);

    const result = await probeDockerOrganizationReadiness({ evidence: readinessEvidence, record });

    expect(inspectDockerDeployment).toHaveBeenCalledTimes(1);
    expect(createDockerProbeGateway).toHaveBeenCalledWith(
      record,
      record.units[0],
      expect.objectContaining({ inspection: inspected })
    );
    expect(gateway.inspectUnit).toHaveBeenCalledTimes(1);
    expect(requestPaths).toEqual(["/healthz"]);
    expect(result).toMatchObject({ code: "identity_mismatch", state: "failed" });

    gatewayIdentity.identity = inspected.identity;
    await expect(probeDockerOrganizationReadiness({ evidence: readinessEvidence, record })).resolves.toMatchObject({
      code: "organization_ready",
      state: "ready"
    });
  });

  it("returns bounded pending, timeout, and cancellation outcomes without a retained ready result", async () => {
    const record = readinessRecord();
    const inspected = readinessInspection();
    vi.mocked(inspectDockerDeployment).mockResolvedValue(new Map([[record.units[0]!.id, inspected]]));
    vi.mocked(createDockerProbeGateway).mockReturnValue({
      exec: vi.fn(async () => ({ stderr: "", stdout: bindingBytes })),
      httpGet: vi.fn(async () => ({ body: "", error: "unavailable", ok: false })),
      inspectUnit: vi.fn(async () => inspected)
    });
    await expect(probeDockerOrganizationReadiness({ evidence: readinessEvidence, record })).resolves.toMatchObject({
      code: "probe_unavailable", state: "pending"
    });

    vi.mocked(inspectDockerDeployment).mockRejectedValueOnce(new Error("timed out"));
    await expect(probeDockerOrganizationReadiness({ evidence: readinessEvidence, record })).resolves.toMatchObject({
      code: "probe_timeout", state: "failed"
    });
    const cancellation = new Error("cancelled");
    cancellation.name = "AbortError";
    vi.mocked(inspectDockerDeployment).mockRejectedValueOnce(cancellation);
    await expect(probeDockerOrganizationReadiness({ evidence: readinessEvidence, record })).resolves.toMatchObject({
      code: "probe_cancelled", state: "cancelled"
    });
  });

  it("detects a root-owned 0600 world-bindings artifact without elevating the probe", async () => {
    const record = readinessRecord();
    const inspected = readinessInspection();
    vi.mocked(inspectDockerDeployment).mockResolvedValue(new Map([[record.units[0]!.id, inspected]]));
    const exec = vi.fn(async (command: string[]) => {
      if (command[0] === "cat" && command[1] === readinessEvidence.worldBindings?.artifactPath) {
        const error = new Error("cat: Permission denied");
        throw error;
      }
      return { stderr: "", stdout: bindingBytes };
    });
    vi.mocked(createDockerProbeGateway).mockReturnValue({
      exec,
      httpGet: vi.fn(async () => ({ body: "", ok: true })),
      inspectUnit: vi.fn(async () => inspected)
    });

    await expect(probeDockerOrganizationReadiness({ evidence: readinessEvidence, record })).resolves.toMatchObject({
      code: "probe_unavailable",
      state: "pending"
    });
    expect(exec).toHaveBeenCalledWith(["cat", "/spawnfile/world-bindings.json"]);
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(["-u", "0"]));
  });

  it("treats an HTTP 401 health rejection as terminal topology mismatch", async () => {
    const record = readinessRecord();
    const inspected = readinessInspection();
    vi.mocked(inspectDockerDeployment).mockResolvedValue(new Map([[record.units[0]!.id, inspected]]));
    vi.mocked(createDockerProbeGateway).mockReturnValue({
      exec: vi.fn(async () => ({ stderr: "", stdout: bindingBytes })),
      httpGet: vi.fn(async () => ({ body: "", error: "HTTP 401", ok: false })),
      inspectUnit: vi.fn(async () => inspected)
    });
    await expect(probeDockerOrganizationReadiness({ evidence: readinessEvidence, record })).resolves.toMatchObject({
      code: "topology_mismatch", state: "failed"
    });
  });
});
