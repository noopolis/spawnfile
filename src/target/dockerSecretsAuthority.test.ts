import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  createTargetSecretSourceAuthorization,
  initializeTargetSecretVersionAuthorityStore,
  parseTargetSecretSourceAuthorization,
  type TargetSecretVersionBinding
} from "./dockerSecretsAuthority.js";
import { DOCKER_SECRET_ERROR } from "./dockerSecretsProvider.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-secret-authority-")));
  roots.push(value); return value;
};
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));
const opaque = (character: string) => parseOpaqueTargetHandle(`opaque_${character.repeat(64)}`);
const authorization = createTargetSecretSourceAuthorization({
  descriptorDigest: `sha256:${"a".repeat(64)}`,
  name: "token",
  operationHandle: opaque("b"),
  requestDigest: `sha256:${"c".repeat(64)}`,
  runId: "run-one",
  scope: "world",
  selectedTarget: { fingerprint: `sha256:${"d".repeat(32)}`, handle: opaque("e") },
  sourceHandle: opaque("f")
});
const binding = (version = "1"): TargetSecretVersionBinding => ({
  authorization,
  sourceVersionHandle: opaque(version)
});

describe("private target-secret version authority", () => {
  it("persists one exact opaque version binding with private modes across reconstructed stores", async () => {
    const directory = await root(); const store = await initializeTargetSecretVersionAuthorityStore(directory);
    await store.bind([binding()]);
    await expect((await initializeTargetSecretVersionAuthorityStore(directory)).bind([binding()])).resolves.toBeUndefined();
    await expect((await initializeTargetSecretVersionAuthorityStore(directory)).bind([binding("2")])).rejects.toThrow(DOCKER_SECRET_ERROR);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json")); expect(files).toHaveLength(2);
    for (const file of files) expect((await stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
    const persisted = (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))).join("\n");
    expect(persisted).toContain(authorization.sourceHandle); expect(persisted).toContain(binding().sourceVersionHandle);
    expect(persisted).not.toContain("secret-value");
  });

  it("atomically permits only one of two conflicting first bindings", async () => {
    const directory = await root();
    const left = await initializeTargetSecretVersionAuthorityStore(directory);
    const right = await initializeTargetSecretVersionAuthorityStore(directory);
    const outcomes = await Promise.allSettled([left.bind([binding("3")]), right.bind([binding("4")])]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("rejects mixed claims, duplicate sources, and hostile authorization graphs", async () => {
    const directory = await root(); const store = await initializeTargetSecretVersionAuthorityStore(directory);
    const changed = createTargetSecretSourceAuthorization({ ...authorization, name: "other", operationHandle: opaque("9") });
    await expect(store.bind([binding(), { authorization: changed, sourceVersionHandle: opaque("8") }])).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(store.bind([binding(), { authorization: { ...authorization, name: "other" }, sourceVersionHandle: opaque("7") }])).rejects.toThrow(DOCKER_SECRET_ERROR);
    expect(() => createTargetSecretSourceAuthorization({ ...authorization, scope: "../world" })).toThrow(DOCKER_SECRET_ERROR);
    expect(() => createTargetSecretSourceAuthorization(new Proxy({ ...authorization }, {}) as never)).toThrow();
  });

  it("rejects unsafe roots, empty batches, and oversized batches", async () => {
    await expect(initializeTargetSecretVersionAuthorityStore("")).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(initializeTargetSecretVersionAuthorityStore("x".repeat(4_097))).rejects.toThrow(DOCKER_SECRET_ERROR);
    const base = await root(); const file = path.join(base, "file"); await writeFile(file, "x");
    await expect(initializeTargetSecretVersionAuthorityStore(file)).rejects.toThrow(DOCKER_SECRET_ERROR);
    const actual = path.join(base, "actual"); const linked = path.join(base, "linked"); await mkdir(actual); await symlink(actual, linked);
    await expect(initializeTargetSecretVersionAuthorityStore(linked)).rejects.toThrow(DOCKER_SECRET_ERROR);
    const store = await initializeTargetSecretVersionAuthorityStore(path.join(base, "valid"));
    await expect(store.bind([])).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(store.bind(Array.from({ length: 33 }, () => binding()))).rejects.toThrow(DOCKER_SECRET_ERROR);
  });

  it.each([
    ["a null packet", null],
    ["an array packet", []],
    ["a selected target that is not a record", { ...authorization, selectedTarget: null }],
    ["a selected target with extra authority", {
      ...authorization,
      selectedTarget: { ...authorization.selectedTarget, privateId: "forbidden" }
    }],
    ["a non-string target fingerprint", {
      ...authorization,
      selectedTarget: { ...authorization.selectedTarget, fingerprint: null }
    }],
    ["a malformed target fingerprint", {
      ...authorization,
      selectedTarget: { ...authorization.selectedTarget, fingerprint: "sha256:nope" }
    }]
  ])("rejects %s", (_name, value) => {
    expect(() => parseTargetSecretSourceAuthorization(value)).toThrow(DOCKER_SECRET_ERROR);
  });

  it("rejects malformed binding records and authority mismatches", async () => {
    const directory = await root();
    const store = await initializeTargetSecretVersionAuthorityStore(directory);
    await expect(store.bind([null as never])).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(store.bind([binding(), {
      authorization: { ...authorization, requestDigest: `sha256:${"9".repeat(64)}` },
      sourceVersionHandle: opaque("7")
    }])).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(store.bind([binding(), {
      authorization: { ...authorization, sourceHandle: opaque("8") },
      sourceVersionHandle: opaque("7")
    }])).rejects.toThrow(DOCKER_SECRET_ERROR);
  });

  it("rejects an authority record whose private mode was widened", async () => {
    const directory = await root();
    const store = await initializeTargetSecretVersionAuthorityStore(directory);
    await store.bind([binding()]);
    const record = (await readdir(directory)).find((file) => file.endsWith(".json"));
    expect(record).toBeDefined();
    await chmod(path.join(directory, record!), 0o644);
    await expect(store.bind([binding()])).rejects.toThrow(DOCKER_SECRET_ERROR);
  });
});
