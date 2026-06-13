import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory } from "../filesystem/index.js";

import { publishProject } from "./publishProject.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/single-agent", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const outDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spawnfile-publish-test-"));
  temporaryDirectories.push(dir);
  return path.join(dir, ".spawn");
};

describe("publishProject", () => {
  it("requires an explicit image tag", async () => {
    await expect(publishProject(FIXTURE, { buildRunner: async () => undefined })).rejects.toThrow(
      /requires --tag/
    );
  });

  it("compiles, verifies, pushes, and resolves the digest", async () => {
    const pushed: string[][] = [];
    const result = await publishProject(FIXTURE, {
      buildRunner: async () => undefined,
      imageTag: "localhost:5000/single-agent:1.0.0",
      outputDirectory: await outDir(),
      pushRunner: async (command, args) => {
        pushed.push([command, ...args]);
        if (args[0] === "image" && args[1] === "inspect") {
          return JSON.stringify(["localhost:5000/single-agent@sha256:pushed"]);
        }
        return "";
      }
    });

    expect(result.imageTag).toBe("localhost:5000/single-agent:1.0.0");
    expect(result.digest).toBe("sha256:pushed");
    expect(pushed.some((call) => call[1] === "push")).toBe(true);
  });

  it("returns a null digest when the inspect call throws", async () => {
    const result = await publishProject(FIXTURE, {
      buildRunner: async () => undefined,
      imageTag: "localhost:5000/single-agent:1.0.0",
      outputDirectory: await outDir(),
      pushRunner: async (_command, args) => {
        if (args[0] === "image" && args[1] === "inspect") {
          throw new Error("inspect failed");
        }
        return "";
      }
    });
    expect(result.digest).toBeNull();
  });

  it("returns a null digest when the registry digest is unavailable", async () => {
    const result = await publishProject(FIXTURE, {
      buildRunner: async () => undefined,
      imageTag: "localhost:5000/single-agent:1.0.0",
      outputDirectory: await outDir(),
      pushRunner: async (_command, args) => {
        if (args[0] === "image" && args[1] === "inspect") {
          return "[]";
        }
        return "";
      }
    });
    expect(result.digest).toBeNull();
  });
});
