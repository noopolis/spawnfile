import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyEndpoint,
  normalizeArchitecture,
  parseBaseImage,
  parseContext,
  parseDockerCommand,
  parseTimeout,
  validateEvidenceDestination
} from "./targetConfigResolverValidation.js";

const roots: string[] = [];
const privateRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-validation-")));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("target config resolver validation", () => {
  it("accepts only bounded context, command, timeout, and image grammar", () => {
    expect(parseContext("prod_1")).toBe("prod_1");
    for (const invalid of [null, "Prod", "a".repeat(65)]) {
      expect(() => parseContext(invalid)).toThrow(/context/u);
    }

    expect(parseDockerCommand("docker-compatible")).toBe("docker-compatible");
    expect(parseDockerCommand("/opt/docker/bin/docker")).toBe("/opt/docker/bin/docker");
    for (const invalid of [null, "docker\0hostile", "relative/docker", "x".repeat(1_025)]) {
      expect(() => parseDockerCommand(invalid)).toThrow(/command/u);
    }

    for (const valid of [1, 120_000]) expect(parseTimeout(valid)).toBe(valid);
    for (const invalid of [0, 120_001, 1.5, "1000"]) {
      expect(() => parseTimeout(invalid)).toThrow(/timeout/u);
    }
    expect(parseBaseImage("node:24-bookworm-slim")).toBe("node:24-bookworm-slim");
    expect(() => parseBaseImage("not an image")).toThrow(/portable image/u);
  });

  it("classifies every supported Docker transport and architecture alias", () => {
    for (const transport of ["fd", "npipe", "unix"] as const) {
      expect(classifyEndpoint(`${transport}://endpoint`)).toEqual({ class: "local", transport });
    }
    for (const transport of ["http", "https", "ssh", "tcp"] as const) {
      expect(classifyEndpoint(`${transport}://endpoint`)).toEqual({ class: "remote", transport });
    }
    for (const invalid of ["socket", "ssh://bad endpoint", `unix://${"x".repeat(4_100)}`]) {
      expect(() => classifyEndpoint(invalid)).toThrow(/endpoint|transport/u);
    }

    for (const value of ["amd64", "x64", "x86_64"]) expect(normalizeArchitecture(value)).toBe("amd64");
    for (const value of ["aarch64", "arm64"]) expect(normalizeArchitecture(value)).toBe("arm64");
    expect(() => normalizeArchitecture(null)).toThrow(/invalid/u);
    expect(() => normalizeArchitecture("riscv64")).toThrow(/unsupported/u);
  });

  it("accepts a missing or private regular destination under one physical private parent", async () => {
    const root = await privateRoot();
    const destination = path.join(root, "evidence.tar");
    await expect(validateEvidenceDestination(destination)).resolves.toBe(destination);
    await writeFile(destination, "evidence", { mode: 0o600 });
    await chmod(destination, 0o600);
    await expect(validateEvidenceDestination(destination)).resolves.toBe(destination);
  });

  it("rejects lexical, parent, and existing-destination filesystem substitution", async () => {
    for (const invalid of [null, "relative.tar", "/tmp/../tmp/evidence.tar", `/tmp/${"x".repeat(4_100)}`, "/tmp/bad\0name"]) {
      await expect(validateEvidenceDestination(invalid)).rejects.toThrow(/absolute normalized path/u);
    }

    const root = await privateRoot();
    const missingParent = path.join(root, "missing", "evidence.tar");
    await expect(validateEvidenceDestination(missingParent)).rejects.toThrow(/unavailable/u);

    const publicParent = path.join(root, "public");
    await mkdir(publicParent, { mode: 0o755 });
    await chmod(publicParent, 0o755);
    await expect(validateEvidenceDestination(path.join(publicParent, "evidence.tar")))
      .rejects.toThrow(/private physical directory/u);

    const physicalParent = path.join(root, "physical");
    const linkedParent = path.join(root, "linked");
    await mkdir(physicalParent, { mode: 0o700 });
    await symlink(physicalParent, linkedParent);
    await expect(validateEvidenceDestination(path.join(linkedParent, "evidence.tar")))
      .rejects.toThrow(/private physical directory/u);

    const directoryDestination = path.join(root, "directory-destination");
    await mkdir(directoryDestination, { mode: 0o700 });
    await expect(validateEvidenceDestination(directoryDestination)).rejects.toThrow(/private regular file/u);

    const publicFile = path.join(root, "public-file");
    await writeFile(publicFile, "evidence", { mode: 0o644 });
    await chmod(publicFile, 0o644);
    await expect(validateEvidenceDestination(publicFile)).rejects.toThrow(/private regular file/u);

    const linkedFile = path.join(root, "linked-file");
    await symlink(publicFile, linkedFile);
    await expect(validateEvidenceDestination(linkedFile)).rejects.toThrow(/private regular file/u);
  });
});
