import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { writeUtf8File, removeDirectory } from "../filesystem/index.js";
import { writeDeploymentRecord, type DeploymentRecord } from "../deployment/index.js";
import { buildUpReceipt } from "./upReceipt.js";
import type { UpProjectResult } from "./upProject.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => removeDirectory(directory)));
});

const evidence: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:0123456789ab", compileVersion: "0.1", hasExternalMoltnet: false,
  networks: [], organizationMembers: [], projectLabel: "football",
  version: "spawnfile.organization-ready-evidence.v1", worldBindings: null
};

const record = (outputDirectory: string): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1:0123456789ab",
  created_at: "2026-07-22T00:00:00.000Z",
  manager: "docker",
  name: "football",
  organization_ready: {
    code: "probe_unavailable",
    compile_fingerprint: "sf1:0123456789ab",
    run_id: "run-123",
    state: "pending",
    unit_id: "football-unit",
    version: "spawnfile.organization-ready.v1",
    world_binding_digest: null
  },
  output_directory: outputDirectory,
  run_id: "run-123",
  source: { kind: "project", root: outputDirectory },
  target: { kind: "host", value: "unix:///var/run/docker.sock" },
  units: [{
    container_id: "opaque-container", container_name: "football", contains: [], id: "football-unit",
    image_id: "opaque-image", image_tag: "football:latest", kind: "container", runtime_instances: []
  }],
  version: "spawnfile.deployment.v2"
});

describe("up receipt organization readiness readback", () => {
  it("returns exact stored bytes/value without a readiness resolver or probe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-receipt-ready-"));
    directories.push(root);
    await writeUtf8File(path.join(root, "AGENTS.md"), "# agent\n");
    await writeUtf8File(path.join(root, "Spawnfile"), [
      'spawnfile_version: "0.1"', "kind: agent", "name: agent", "runtime: openclaw", "workspace:",
      "  docs:", "    system: AGENTS.md", ""
    ].join("\n"));
    const stored = record(root);
    const deploymentRecordPath = await writeDeploymentRecord(root, stored);
    const result: UpProjectResult = {
      authProfileName: null,
      containerName: "football",
      deploymentRecordPath,
      imageTag: "football:latest",
      organizationReadinessEvidence: evidence,
      outputDirectory: root,
      report: {
        compile_fingerprint: "sf1:0123456789ab",
        container: {
          dockerfile: "Dockerfile", entrypoint: "entrypoint", env_example: ".env.example",
          model_secrets_required: [], ports: [], runtime_homes: [], runtime_instances: [],
          runtime_secrets_required: [], runtimes_installed: [], secrets_required: []
        }, diagnostics: [], nodes: [], root, spawnfile_version: "0.1"
      },
      reportPath: path.join(root, "spawnfile-report.json"),
      supportDirectory: null
    };

    const receipt = await buildUpReceipt(root, result);
    expect(receipt.organization_ready).toEqual(stored.organization_ready);
    expect(JSON.stringify(receipt.organization_ready)).not.toContain("opaque-container");
  });
});
