import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory } from "../filesystem/index.js";

import {
  parseDeploymentRecord,
  readDeploymentRecordFromOutput,
  writeDeploymentRecord,
  type DeploymentRecord
} from "./record.js";

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
