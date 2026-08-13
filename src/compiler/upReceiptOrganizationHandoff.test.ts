import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";
import {
  createOrganizationHandoff, parseCanonicalSha256Digest, writeDeploymentRecord,
  type DeploymentRecord
} from "../deployment/index.js";
import { parseOpaqueTargetHandle } from "../target/index.js";
import { buildUpReceipt } from "./upReceipt.js";
import type { UpProjectResult } from "./upProject.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("up receipt organization handoff readback", () => {
  it("reads only the record handoff and does not add one when it is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-receipt-handoff-"));
    directories.push(root);
    await writeUtf8File(path.join(root, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(path.join(root, "Spawnfile"), [
      'spawnfile_version: "0.1"', "kind: agent", "name: agent", "runtime: openclaw", "workspace:",
      "  docs:", "    system: AGENTS.md", ""
    ].join("\n"));
    const handoff = createOrganizationHandoff("run-from-host", {
      bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
      networkAttachmentHandle: parseOpaqueTargetHandle("opaque_0123456789abcdef"),
      selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`)
    });
    const record: DeploymentRecord = {
      auth_profile: null, compile_fingerprint: "sf1:0123456789ab", created_at: "2026-07-22T00:00:00.000Z",
      manager: "docker", name: "football", output_directory: root, run_id: "run-from-host",
      source: { kind: "project", root }, target: { kind: "host", value: "unix:///var/run/docker.sock" },
      units: [{ container_id: "opaque-container", container_name: "football", contains: [], id: "football-unit",
        image_id: "opaque-image", image_tag: "football:latest", kind: "container", runtime_instances: [] }],
      version: "spawnfile.deployment.v2", organization_handoff: handoff
    };
    const result = (recordPath: string): UpProjectResult => ({
      authProfileName: null, containerName: "football", deploymentRecordPath: recordPath, imageTag: "football:latest",
      organizationReadinessEvidence: { compileFingerprint: "sf1:0123456789ab", compileVersion: "0.1",
        hasExternalMoltnet: false, networks: [], organizationMembers: [], projectLabel: "football",
        version: "spawnfile.organization-ready-evidence.v1", worldBindings: null }, outputDirectory: root,
      report: { compile_fingerprint: "sf1:0123456789ab", container: { dockerfile: "Dockerfile", entrypoint: "entrypoint",
        env_example: ".env.example", model_secrets_required: [], ports: [], runtime_homes: [], runtime_instances: [],
        runtime_secrets_required: [], runtimes_installed: [], secrets_required: [] }, diagnostics: [], nodes: [], root,
      spawnfile_version: "0.1" }, reportPath: path.join(root, "spawnfile-report.json"), supportDirectory: null
    });
    const present = await buildUpReceipt(root, result(await writeDeploymentRecord(root, record)));
    expect(present.organization_handoff).toEqual(handoff);
    const absentRecord = { ...record };
    delete absentRecord.organization_handoff;
    const absent = await buildUpReceipt(root, result(await writeDeploymentRecord(root, absentRecord)));
    expect(absent).not.toHaveProperty("organization_handoff");
  });
});
