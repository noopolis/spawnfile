import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory } from "../filesystem/index.js";

import {
  parseDeploymentRecord,
  deploymentRecordSchema,
  readDeploymentRecordFromOutput,
  writeDeploymentRecord,
  type DeploymentRecord
} from "./record.js";
import type { OrganizationReadiness } from "./organizationReady.js";
import { createOrganizationHandoff, parseCanonicalSha256Digest } from "./organizationHandoffTypes.js";
import { parseOpaqueTargetHandle } from "../target/index.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-deployment-"));
  temporaryDirectories.push(directory);
  return directory;
};

const createRecord = (outputDirectory: string): DeploymentRecord => ({
  auth_profile: "prod",
  compile_fingerprint: "sf1:abc123",
  created_at: "2026-06-11T00:00:00.000Z",
  env_file: "/tmp/prod.env",
  manager: "docker",
  name: "prod-eu",
  output_directory: outputDirectory,
  source: { kind: "project", root: "/tmp/project" },
  target: {
    endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
    kind: "context",
    name: "hetzner"
  },
  units: [
    {
      container_id: "container-123",
      container_name: "spawnfile-project",
      contains: [{ id: "agent:assistant", kind: "agent" }],
      id: "prod-eu-container",
      image_id: "image-123",
      image_tag: "spawnfile-project",
      kind: "container",
      runtime_instances: ["agent-assistant"]
    }
  ],
  version: "spawnfile.deployment.v2"
});

const organizationReadiness: OrganizationReadiness = {
  code: "organization_ready",
  compile_fingerprint: "sf1:0123456789ab",
  run_id: "run-123",
  state: "ready",
  unit_id: "prod-eu-unit",
  version: "spawnfile.organization-ready.v1",
  world_binding_digest: `sha256:${"a".repeat(64)}`
};

const organizationReadyStates = ["ready", "pending", "failed", "cancelled"] as const;
const organizationReadyCodes = [
  "organization_ready", "external_moltnet", "compiled_evidence_missing", "unit_unavailable",
  "unit_restarted", "probe_unavailable", "identity_mismatch", "topology_mismatch", "probe_timeout",
  "probe_cancelled"
] as const;
const validOrganizationReadyMappings = new Set([
  "ready:organization_ready",
  "pending:external_moltnet", "pending:compiled_evidence_missing", "pending:unit_unavailable",
  "pending:unit_restarted", "pending:probe_unavailable",
  "failed:identity_mismatch", "failed:topology_mismatch", "failed:probe_timeout",
  "cancelled:probe_cancelled"
]);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("deployment records", () => {
  it("writes and reads records under .spawn/deployments", async () => {
    const outputDirectory = await createTempDirectory();
    const record = createRecord(outputDirectory);

    const recordPath = await writeDeploymentRecord(outputDirectory, record);

    expect(recordPath).toBe(path.join(outputDirectory, "deployments", "prod-eu.json"));
    expect(JSON.parse(await readUtf8File(recordPath))).toEqual(record);
    await expect(readDeploymentRecordFromOutput(outputDirectory, "prod-eu")).resolves.toEqual(record);
  });

  it("rejects malformed records", () => {
    expect(() => parseDeploymentRecord({
      ...createRecord("/tmp/out"),
      env_file: "/tmp/prod.env",
      name: "Prod"
    })).toThrow(/kebab-case/);

    expect(() => parseDeploymentRecord({
      ...createRecord("/tmp/out"),
      target: {
        endpoint_fingerprint: "ssh://host",
        kind: "context",
        name: "default"
      }
    })).toThrow(/Invalid deployment record/);
  });

  it("persists strict organization readiness without changing records that omit it", async () => {
    const outputDirectory = await createTempDirectory();
    const readyRecord = { ...createRecord(outputDirectory), organization_ready: organizationReadiness };
    await expect(writeDeploymentRecord(outputDirectory, readyRecord)).resolves.toBeDefined();
    await expect(readDeploymentRecordFromOutput(outputDirectory, "prod-eu")).resolves.toEqual(readyRecord);
    expect(parseDeploymentRecord(createRecord(outputDirectory))).not.toHaveProperty("organization_ready");

    const prototypeBearing = Object.assign(Object.create({ inherited: true }), organizationReadiness);
    const hostileValues = [
      { ...organizationReadiness, error: "raw failure" },
      { ...organizationReadiness, token_env: "WORLD_TOKEN" },
      { ...organizationReadiness, code: "unbounded" },
      { ...organizationReadiness, state: "pending", code: "organization_ready" },
      { ...organizationReadiness, state: "failed", code: "probe_unavailable" },
      { ...organizationReadiness, compile_fingerprint: "sf1:bad" },
      { ...organizationReadiness, unit_id: "not valid" },
      { ...organizationReadiness, run_id: "bad/run" },
      { ...organizationReadiness, world_binding_digest: "sha256:bad" },
      { ...organizationReadiness, run_id: null },
      prototypeBearing
    ];
    expect(deploymentRecordSchema.safeParse(readyRecord).success).toBe(true);
    expect(deploymentRecordSchema.safeParse({ ...readyRecord, organization_ready: { ...organizationReadiness, world_binding_digest: null } }).success).toBe(true);
    for (const organization_ready of hostileValues) {
      expect(deploymentRecordSchema.safeParse({ ...createRecord(outputDirectory), organization_ready }).success)
        .toBe(false);
      expect(() => parseDeploymentRecord({
        ...createRecord(outputDirectory),
        organization_ready
      })).toThrow(/organization-ready/u);
    }
  });

  it("exhaustively proves the organization readiness mapping at the parent schema", () => {
    for (const state of organizationReadyStates) {
      for (const code of organizationReadyCodes) {
        const organization_ready = { ...organizationReadiness, state, code };
        const accepted = deploymentRecordSchema.safeParse({
          ...createRecord("/tmp/out"),
          organization_ready
        }).success;
        expect(accepted, `${state}/${code}`).toBe(validOrganizationReadyMappings.has(`${state}:${code}`));
      }
    }
  });

  it("reads v1 records and upgrades them to the v2 source union", () => {
    const v1 = {
      auth_profile: "prod",
      compile_fingerprint: "sf1:abc123",
      created_at: "2026-06-11T00:00:00.000Z",
      manager: "docker",
      name: "prod-eu",
      output_directory: "/tmp/project/.spawn",
      project_root: "/tmp/project",
      target: {
        endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
        kind: "context",
        name: "hetzner"
      },
      units: [
        {
          container_id: "container-123",
          container_name: "spawnfile-project",
          contains: [{ id: "agent:assistant", kind: "agent" }],
          id: "prod-eu-container",
          image_id: "image-123",
          image_tag: "spawnfile-project",
          kind: "container",
          runtime_instances: ["agent-assistant"]
        }
      ],
      version: "spawnfile.deployment.v1"
    };

    const record = parseDeploymentRecord(v1);
    expect(record.version).toBe("spawnfile.deployment.v2");
    expect(record.source).toEqual({ kind: "project", root: "/tmp/project" });
    expect(record.output_directory).toBe("/tmp/project/.spawn");
    expect(record.units[0]?.contains).toEqual([{ id: "agent:assistant", kind: "agent" }]);
  });

  it("accepts v2 image-source records with network contains and per-unit targets", () => {
    const record = parseDeploymentRecord({
      auth_profile: "me",
      compile_fingerprint: "sf1:abc123",
      created_at: "2026-06-13T00:00:00.000Z",
      manager: "docker",
      name: "research",
      output_directory: null,
      source: { digest: "sha256:feed", kind: "image", ref: "you/research-cell:1.0.0" },
      target: {
        endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
        kind: "context",
        name: "default"
      },
      units: [
        {
          container_id: "container-9",
          container_name: "spawnfile-research",
          contains: [
            { id: "agent:analyst", kind: "agent" },
            { id: "dist_lab", kind: "network" }
          ],
          id: "research-container",
          image_id: "image-9",
          image_tag: "you/research-cell:1.0.0",
          kind: "container",
          manager: "docker",
          runtime_instances: ["agent-analyst"],
          target: {
            endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
            kind: "context",
            name: "vm1"
          }
        }
      ],
      version: "spawnfile.deployment.v2"
    });

    expect(record.source.kind).toBe("image");
    expect(record.units[0]?.target).toMatchObject({ kind: "context", name: "vm1" });
  });

  it("round-trips an optional organization handoff without exposing hostile fields", async () => {
    const outputDirectory = await createTempDirectory();
    const record = {
      ...createRecord(outputDirectory),
      organization_handoff: createOrganizationHandoff("run-2026-07-22", {
        bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
        networkAttachmentHandle: parseOpaqueTargetHandle("opaque_0123456789abcdef"),
        selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`)
      }), organization_handoff_handle: parseOpaqueTargetHandle(`opaque_${"f".repeat(64)}`)
    };
    const recordPath = await writeDeploymentRecord(outputDirectory, record);
    const serialized = await readUtf8File(recordPath);

    expect(await readDeploymentRecordFromOutput(outputDirectory, "prod-eu")).toEqual(record);
    for (const value of ["container-123", "image-123", "prod.env", "ssh://", "secret", "labels", "error"]) {
      expect(JSON.stringify(record.organization_handoff)).not.toContain(value);
    }
    expect(serialized).toContain('"organization_handoff"');
    expect(serialized).toContain('"organization_handoff_handle"');
  });

  it("preserves legacy v2 serialized bytes when organization handoff is absent", () => {
    const record = createRecord("/tmp/out");
    const parsed = parseDeploymentRecord(record);

    expect(JSON.stringify(parsed, null, 2)).toBe(JSON.stringify(record, null, 2));
    expect(parsed).not.toHaveProperty("organization_handoff");
  });

  it("rejects image records missing the digest field", () => {
    expect(() =>
      parseDeploymentRecord({
        auth_profile: null,
        compile_fingerprint: "sf1:abc123",
        created_at: "2026-06-13T00:00:00.000Z",
        manager: "docker",
        name: "research",
        output_directory: null,
        source: { kind: "image", ref: "you/research-cell:1.0.0" },
        target: {
          endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
          kind: "context",
          name: "default"
        },
        units: [],
        version: "spawnfile.deployment.v2"
      })
    ).toThrow(/Invalid deployment record/);
  });
});
