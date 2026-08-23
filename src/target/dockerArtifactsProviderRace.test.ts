import { link, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { initializeDockerArtifactIdentityStore } from "./dockerArtifactsProvider.js";

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const binding = {
  artifactManifestDigest: digest("a"), imageDigest: digest("b"),
  imageReference: `registry.example/world@${digest("b")}`,
  operationHandle: parseOpaqueTargetHandle("opaque_aaaaaaaaaaaaaaaa"),
  requestDigest: digest("c"), resultHandle: parseOpaqueTargetHandle("opaque_dddddddddddddddd"),
  selectedTargetHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee"),
};

const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-artifact-race-")));
  roots.push(value);
  return path.join(value, "identities");
};
const pendingFromInterruptedBind = async (identityRoot: string): Promise<string> => {
  const interrupted = await initializeDockerArtifactIdentityStore(identityRoot, {
    beforePublish: async () => { throw new Error("crash"); },
  });
  await expect(interrupted.bind(binding)).rejects.toThrow("Docker artifact resolution failed");
  const entry = (await readdir(identityRoot)).find((name) => name.endsWith(".pending"));
  if (!entry) throw new Error("expected pending identity");
  return path.join(identityRoot, entry);
};

afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

describe("Docker artifact identity publication races", () => {
  it("fails closed for a non-prefix pending identity", async () => {
    const identityRoot = await root(); const pending = await pendingFromInterruptedBind(identityRoot);
    await writeFile(pending, "not-a-canonical-prefix", { mode: 0o600 });
    await expect((await initializeDockerArtifactIdentityStore(identityRoot)).bind(binding))
      .rejects.toThrow("Docker artifact resolution failed");
  });

  it("does not accept a pending hardlink pair without its exact final", async () => {
    const identityRoot = await root(); const pending = await pendingFromInterruptedBind(identityRoot);
    await link(pending, `${pending}.copy`);
    await expect((await initializeDockerArtifactIdentityStore(identityRoot)).bind(binding))
      .rejects.toThrow("Docker artifact resolution failed");
  });

  it("rejects a final and pending pair that are not the same inode", async () => {
    const identityRoot = await root(); const store = await initializeDockerArtifactIdentityStore(identityRoot);
    await store.bind(binding);
    const finalEntry = (await readdir(identityRoot)).find((name) => name.endsWith(".identity.json"));
    if (!finalEntry) throw new Error("expected final identity");
    const final = path.join(identityRoot, finalEntry); const pending = path.join(identityRoot, `.${finalEntry}.pending`);
    await writeFile(pending, await readFile(final, "utf8"), { mode: 0o600 });
    await Promise.all([link(final, `${final}.copy`), link(pending, `${pending}.copy`)]);
    await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest))
      .rejects.toThrow("Docker artifact resolution failed");
  });
});
