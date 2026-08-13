import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./buildProject.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./buildProject.js")>();
  return { ...actual, buildProject: vi.fn() };
});

vi.mock("../deployment/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deployment/index.js")>();
  return {
    ...actual,
    probeDockerOrganizationReadiness: vi.fn(),
    readDeploymentRecord: vi.fn(),
    writeDeploymentRecord: vi.fn(),
    writeDockerDeploymentRecordForRun: vi.fn()
  };
});

import { buildProject, type BuildProjectResult } from "./buildProject.js";
import { upProject } from "./upProject.js";
import {
  probeDockerOrganizationReadiness,
  readDeploymentRecord,
  writeDeploymentRecord,
  writeDockerDeploymentRecordForRun,
  type DeploymentRecord
} from "../deployment/index.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

const evidence: OrganizationReadinessEvidence = Object.freeze({
  compileFingerprint: "sf1:0123456789ab",
  compileVersion: "0.1",
  hasExternalMoltnet: false,
  networks: Object.freeze([]),
  organizationMembers: Object.freeze([]),
  projectLabel: "football",
  version: "spawnfile.organization-ready-evidence.v1",
  worldBindings: null
});

const record: DeploymentRecord = {
  auth_profile: null,
  compile_fingerprint: evidence.compileFingerprint,
  created_at: "2026-07-22T00:00:00.000Z",
  manager: "docker",
  name: "football",
  output_directory: "/tmp/spawnfile-ready",
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
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("upProject organization readiness authority", () => {
  it("writes pending before the manager probe and replaces it once with its bounded terminal result", async () => {
    vi.mocked(buildProject).mockResolvedValue({
      imageTag: "football:latest",
      organizationReadinessEvidence: evidence,
      outputDirectory: "/tmp/spawnfile-ready",
      report: {
        compile_fingerprint: evidence.compileFingerprint,
        container: {
          dockerfile: "Dockerfile", entrypoint: "entrypoint", env_example: ".env.example",
          model_secrets_required: [], ports: [], runtime_homes: [], runtime_instances: [],
          runtime_secrets_required: [], runtimes_installed: [], secrets_required: []
        }, diagnostics: [], nodes: [], root: "/tmp/project", spawnfile_version: "0.1"
      } as BuildProjectResult["report"],
      reportPath: "/tmp/spawnfile-ready/spawnfile-report.json"
    });
    vi.mocked(writeDockerDeploymentRecordForRun).mockResolvedValue("/tmp/spawnfile-ready/deployments/football.json");
    vi.mocked(readDeploymentRecord).mockResolvedValue(record);
    vi.mocked(writeDeploymentRecord).mockResolvedValue("/tmp/spawnfile-ready/deployments/football.json");
    vi.mocked(probeDockerOrganizationReadiness).mockImplementation(async (input) => {
      expect(vi.mocked(writeDeploymentRecord)).toHaveBeenCalledTimes(1);
      expect(input.record.organization_ready).toMatchObject({ code: "compiled_evidence_missing", state: "pending" });
      return {
        ...input.record.organization_ready!,
        code: "probe_unavailable",
        state: "pending"
      };
    });

    await upProject("/tmp/project", {
      deploymentName: "football",
      detach: true,
      runRunner: async () => ({ containerId: "opaque-container" })
    });

    expect(writeDeploymentRecord).toHaveBeenCalledTimes(2);
    const [firstOutput, firstRecord] = vi.mocked(writeDeploymentRecord).mock.calls[0]!;
    const [secondOutput, secondRecord] = vi.mocked(writeDeploymentRecord).mock.calls[1]!;
    expect(firstOutput).toBe("/tmp/spawnfile-ready");
    expect(secondOutput).toBe("/tmp/spawnfile-ready");
    expect(firstRecord.organization_ready).toMatchObject({ code: "compiled_evidence_missing", state: "pending" });
    expect(secondRecord.organization_ready).toMatchObject({ code: "probe_unavailable", state: "pending" });
    expect(probeDockerOrganizationReadiness).toHaveBeenCalledWith(expect.objectContaining({
      evidence,
      record: firstRecord
    }));
  });

  it("preserves legacy non-detached absence without writing readiness", async () => {
    vi.mocked(buildProject).mockResolvedValue({
      imageTag: "football:latest", organizationReadinessEvidence: evidence,
      outputDirectory: "/tmp/spawnfile-ready",
      report: {
        container: {
          dockerfile: "Dockerfile", entrypoint: "entrypoint", env_example: ".env.example",
          model_secrets_required: [], ports: [], runtime_homes: [], runtime_instances: [],
          runtime_secrets_required: [], runtimes_installed: [], secrets_required: []
        }, diagnostics: [], nodes: [], root: "/tmp/project", spawnfile_version: "0.1"
      } as BuildProjectResult["report"],
      reportPath: path.join("/tmp/spawnfile-ready", "spawnfile-report.json")
    });
    await upProject("/tmp/project", { runRunner: async () => undefined });
    expect(writeDeploymentRecord).not.toHaveBeenCalled();
    expect(probeDockerOrganizationReadiness).not.toHaveBeenCalled();
  });
});
