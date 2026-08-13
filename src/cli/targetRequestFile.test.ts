import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readTargetRequestFile } from "./targetRequestFile.js";

const roots: string[] = [];
const request = {
  idempotency_key: "idem_aaaaaaaaaaaaaaaa",
  operation: "select_target",
  target_reference: "gpu-4090",
  version: "spawnfile.target-resource.request.v1"
};

const fixture = async (bytes: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-request-"));
  roots.push(root);
  const file = path.join(root, "request.json");
  await writeFile(file, bytes);
  return file;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("readTargetRequestFile", () => {
  it("reads one strict target request object", async () => {
    const file = await fixture(JSON.stringify(request));
    await expect(readTargetRequestFile(file)).resolves.toEqual(request);
  });

  it("rejects non-objects, malformed JSON, and strict-contract violations", async () => {
    for (const bytes of ["[]", "{", JSON.stringify({ ...request, extra: true })]) {
      await expect(readTargetRequestFile(await fixture(bytes))).rejects.toThrow();
    }
  });

  it("enforces the configured byte limit", async () => {
    const bytes = JSON.stringify(request);
    const file = await fixture(bytes);
    await expect(readTargetRequestFile(file, Buffer.byteLength(bytes) - 1)).rejects.toThrow(
      "bounded regular file"
    );
    await expect(readTargetRequestFile(file, 0)).rejects.toThrow("byte limit is invalid");
    await expect(readTargetRequestFile(file, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      "byte limit is invalid"
    );
  });

  it("requires an exact, bounded absolute request-file path before filesystem access", async () => {
    const file = await fixture(JSON.stringify(request));
    await expect(readTargetRequestFile(path.relative(process.cwd(), file))).rejects.toThrow(
      "path is invalid"
    );
    const ancestorPath = `${path.dirname(file)}/../${path.basename(path.dirname(file))}/${path.basename(file)}`;
    await expect(readTargetRequestFile(ancestorPath)).rejects.toThrow("path is invalid");
    await expect(readTargetRequestFile(`${file}\0suffix`)).rejects.toThrow("path is invalid");
    await expect(readTargetRequestFile(`/${"a".repeat(4_097)}`)).rejects.toThrow("path is invalid");
  });

  it("uses current Node file and JSON semantics without stronger claims", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-request-link-"));
    roots.push(root);
    const target = path.join(root, "target.json");
    const link = path.join(root, "request.json");
    await writeFile(target, `{"operation":"cleanup_run","operation":"select_target","idempotency_key":"idem_aaaaaaaaaaaaaaaa","target_reference":"gpu-4090","version":"spawnfile.target-resource.request.v1"}`);
    await symlink(target, link);
    await expect(readTargetRequestFile(link)).resolves.toEqual(request);
    await expect(readTargetRequestFile(await fixture(`\uFEFF${JSON.stringify(request)}`))).rejects.toThrow();
  });
});
