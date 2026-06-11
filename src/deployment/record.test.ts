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
});
