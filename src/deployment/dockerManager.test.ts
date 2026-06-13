import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory } from "../filesystem/index.js";

import {
  createDockerDeploymentRecord,
  createDockerProjectLabel,
  writeDockerDeploymentRecord,
  writeDockerDeploymentRecordForRun
} from "./dockerManager.js";
import { createDockerDeploymentTarget } from "./target.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-deployment-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
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
          image_id: "image-123",
          runtime_instances: ["agent-worker"]
        })
      ]
    });
    expect(record.target).not.toHaveProperty("endpoint");
  });

  it("derives identifier project labels from paths without preserving the path", () => {
    expect(createDockerProjectLabel("/Users/apresmoi/Documents/project/Spawnfile")).toBe("project");
  });

  it("prefers the manifest project name over the checkout directory when provided", () => {
    expect(
      createDockerProjectLabel("/Users/apresmoi/Documents/project/Spawnfile", "Research Cell")
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
});
