import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTargetLocalBundleReceiptDigest, type TargetLocalBundlePrepareRequest } from "./containerBundleContracts.js";
import { initializeFilesystemTargetLocalBundleStore } from "./containerBundleFilesystemStore.js";
import type { TargetLocalBundlePrivateMapping } from "./containerBundleStore.js";
import { parseOpaqueTargetHandle, type OpaqueTargetHandle } from "./contracts.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-fs-validation-"));
  roots.push(value);
  return value;
};
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const request = (idempotency = "idem_abcdefghijklmnop"): TargetLocalBundlePrepareRequest => ({
  archive_base64: "YQ==",
  archive_digest: "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  archive_entries: ["vendor/runtime/start.mjs"],
  artifact_digest: digest("b"),
  build_policy_digest: digest("c"),
  bundle_digest: digest("d"),
  entrypoint: "vendor/runtime/start.mjs",
  idempotency_key: idempotency,
  launcher_digest: digest("e"),
  network_alias: "world",
  platform: { architecture: "amd64", os: "linux" },
  platform_digest: digest("f"),
  selected_target: { fingerprint: `sha256:${"1".repeat(32)}`, handle: parseOpaqueTargetHandle(`opaque_${"a".repeat(32)}`) },
  version: "spawnfile.target-local-container-bundle.prepare-request.v1",
});
const gcTag = (requestDigest: string): string => `spfb_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.gc-tag.v1\0", "utf8").update(requestDigest).digest("hex").slice(0, 58)}`;
const mappingHandle = (operation: OpaqueTargetHandle, requestDigest: string): OpaqueTargetHandle => parseOpaqueTargetHandle(`opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.mapping.v1\0", "utf8").update(`${operation}\0${requestDigest}`, "utf8").digest("hex")}`);
const mapping = (input: TargetLocalBundlePrepareRequest, operation: OpaqueTargetHandle, requestDigest: string): TargetLocalBundlePrivateMapping => ({
  archive_digest: input.archive_digest, artifact_digest: input.artifact_digest, base_image_config_digest: digest("9"),
  build_policy_digest: input.build_policy_digest, bundle_digest: input.bundle_digest, config_id: digest("8"), daemon_epoch: digest("7"),
  entrypoint: input.entrypoint, gc_tag: gcTag(requestDigest), identity_kind: "docker_image_config_digest", launcher_digest: input.launcher_digest,
  network_alias: input.network_alias, operation_handle: operation, platform: input.platform, platform_digest: input.platform_digest,
  request_digest: requestDigest, selected_target: input.selected_target,
});
const receipt = (input: TargetLocalBundlePrepareRequest, operation: OpaqueTargetHandle, requestDigest: string) => {
  const raw = { archive_digest: input.archive_digest, artifact_digest: input.artifact_digest, build_policy_digest: input.build_policy_digest,
    bundle_digest: input.bundle_digest, launcher_digest: input.launcher_digest, mapping_handle: mappingHandle(operation, requestDigest), network_alias: input.network_alias,
    operation_handle: operation, platform: input.platform, platform_digest: input.platform_digest, receipt_digest: digest("0"), request_digest: requestDigest,
    selected_target: input.selected_target, version: "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const };
  return { ...raw, receipt_digest: createTargetLocalBundleReceiptDigest(raw) };
};
const stateFile = (directory: string): string => path.join(directory, "container-bundles.json");
const archiveFile = (directory: string): string => path.join(directory, "archives", request().archive_digest.slice(7));

describe("container bundle filesystem-store validation", () => {
  it("rejects noncanonical, root, regular-file, and symlink authority paths", async () => {
    const parent = await root();
    const file = path.join(parent, "file");
    await writeFile(file, "x", { mode: 0o600 });
    const linked = path.join(parent, "linked");
    await symlink(parent, linked);
    const invalid: unknown[] = [null, "relative", path.parse(parent).root, `/${"x".repeat(4_097)}`, `${parent}/a/../b`, file, linked];
    for (const value of invalid) await expect(initializeFilesystemTargetLocalBundleStore(value)).rejects.toThrow("Target-local container bundle store failed");
  });

  it("rejects malformed public replay joins and supports bounded read-only lookup", async () => {
    const directory = await root();
    const store = await initializeFilesystemTargetLocalBundleStore(directory);
    const invalid: unknown[] = [null, [], {},
      { idempotency_key: "bad", maximum_wait_ms: 0, request_digest: digest("0") },
      { idempotency_key: "idem_abcdefghijklmnop", maximum_wait_ms: 0, request_digest: "bad" },
      { idempotency_key: "idem_abcdefghijklmnop", maximum_wait_ms: -1, request_digest: digest("0") },
      { idempotency_key: "idem_abcdefghijklmnop", maximum_wait_ms: 30_001, request_digest: digest("0") }];
    for (const value of invalid) await expect(store.awaitReplay(value as never)).rejects.toThrow("Target-local container bundle store failed");
    await expect(store.awaitReplay({ idempotency_key: "idem_abcdefghijklmnop", maximum_wait_ms: 0, request_digest: digest("0") }))
      .resolves.toMatchObject({ status: "not_applied" });
    const reserved = await store.reserve(request());
    if (reserved.kind !== "owner") throw new Error("expected owner");
    await expect(store.awaitReplay({ idempotency_key: request().idempotency_key, maximum_wait_ms: 0, request_digest: reserved.request_digest }))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("persists every mutation wrapper and resolves only completed mappings", async () => {
    const directory = await root();
    const store = await initializeFilesystemTargetLocalBundleStore(directory);
    const input = request();
    const reserved = await store.reserve(input);
    if (reserved.kind !== "owner") throw new Error("expected owner");
    await store.renew({ lease: reserved.lease });
    const inflight = await store.beginBuild({ lease: reserved.lease });
    const retried = await store.retryPrebuild({ lease: inflight });
    const rebuilt = await store.beginBuild({ lease: retried });
    const value = mapping(input, reserved.operation_handle, reserved.request_digest);
    await expect(store.resolve({ operation_handle: reserved.operation_handle, request_digest: reserved.request_digest })).resolves.toBeNull();
    const postbuild = await store.stagePostbuild({ lease: rebuilt, mapping: value });
    await store.complete({ lease: postbuild, mapping: value, receipt: receipt(input, reserved.operation_handle, reserved.request_digest) });
    await expect(store.resolve({ operation_handle: reserved.operation_handle, request_digest: reserved.request_digest })).resolves.toEqual(value);
    await expect(store.resolvePrepared({ artifact_digest: input.artifact_digest, build_policy_digest: input.build_policy_digest,
      bundle_digest: input.bundle_digest, selected_target: input.selected_target })).resolves.toMatchObject({ mapping: value });

    const incompleteInput = request("idem_qrstuvwxyzabcdef");
    const incomplete = await store.reserve(incompleteInput);
    if (incomplete.kind !== "owner") throw new Error("expected owner");
    await store.markIncomplete({ lease: incomplete.lease, operation_handle: incomplete.operation_handle, request_digest: incomplete.request_digest });
    await expect(store.lookup({ idempotency_key: incompleteInput.idempotency_key, request_digest: incomplete.request_digest })).resolves.toMatchObject({ status: "not_applied" });
  });

  it("recovers an old exact lock and rejects hostile lock inodes", async () => {
    const staleDirectory = await root();
    const stale = await initializeFilesystemTargetLocalBundleStore(staleDirectory);
    const staleLock = `${stateFile(staleDirectory)}.lock`;
    await writeFile(staleLock, "", { mode: 0o600 });
    await utimes(staleLock, new Date(0), new Date(0));
    await expect(stale.reserve(request())).resolves.toMatchObject({ kind: "owner" });

    const wrongModeDirectory = await root();
    const wrongMode = await initializeFilesystemTargetLocalBundleStore(wrongModeDirectory);
    await writeFile(`${stateFile(wrongModeDirectory)}.lock`, "", { mode: 0o640 });
    await expect(wrongMode.reserve(request())).rejects.toThrow("Target-local container bundle store failed");

    const directoryLockDirectory = await root();
    const directoryLock = await initializeFilesystemTargetLocalBundleStore(directoryLockDirectory);
    await mkdir(`${stateFile(directoryLockDirectory)}.lock`);
    await expect(directoryLock.reserve(request())).rejects.toThrow("Target-local container bundle store failed");
  });

  it("rejects malformed private state and stripped-request corruption", async () => {
    const mutations: ReadonlyArray<(state: Record<string, unknown>) => unknown> = [
      () => null,
      () => [],
      (state) => ({ ...state, records: "bad" }),
      (state) => ({ ...state, extra: true }),
      (state) => ({ ...state, version: "spawnfile.target-local-container-bundle.private.v1" }),
      (state) => ({ ...state, records: [null] }),
      (state) => ({ ...state, records: [{ ...(state.records as Record<string, unknown>[])[0], request: null }] }),
      (state) => {
        const record = (state.records as Record<string, unknown>[])[0]!;
        return { ...state, records: [{ ...record, request: { ...(record.request as Record<string, unknown>), archive_base64: "YQ==" } }] };
      },
      (state) => {
        const record = (state.records as Record<string, unknown>[])[0]!;
        return { ...state, records: [{ ...record, request: { ...(record.request as Record<string, unknown>), archive_digest: null } }] };
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const directory = await root();
      const store = await initializeFilesystemTargetLocalBundleStore(directory);
      await store.reserve(request());
      const state = JSON.parse(await readFile(stateFile(directory), "utf8")) as Record<string, unknown>;
      const value = mutate(state);
      await writeFile(stateFile(directory), index === 0 ? "{" : JSON.stringify(value), "utf8");
      await expect(store.lookup({ idempotency_key: request().idempotency_key, request_digest: digest("0") }))
        .rejects.toThrow("Target-local container bundle store failed");
    }
  });

  it("rejects missing, corrupt, linked, and wrong-mode archive records", async () => {
    const mutations: ReadonlyArray<(directory: string, file: string) => Promise<void>> = [
      async (_directory, file) => { await unlink(file); },
      async (_directory, file) => { await writeFile(file, "b", "utf8"); },
      async (_directory, file) => { await chmod(file, 0o640); },
      async (directory, file) => { await link(file, path.join(directory, "archive-peer")); },
    ];
    for (const mutate of mutations) {
      const directory = await root();
      const store = await initializeFilesystemTargetLocalBundleStore(directory);
      await store.reserve(request());
      await mutate(directory, archiveFile(directory));
      await expect(store.lookup({ idempotency_key: request().idempotency_key, request_digest: digest("0") }))
        .rejects.toThrow("Target-local container bundle store failed");
    }
  });

  it("rejects hostile state-file types, links, sizes, and filesystem policy denial", async () => {
    const mutations: ReadonlyArray<(directory: string, file: string) => Promise<void>> = [
      async (_directory, file) => { await chmod(file, 0o640); },
      async (directory, file) => { await link(file, path.join(directory, "state-peer")); },
      async (_directory, file) => { await writeFile(file, "x".repeat(4_194_305), "utf8"); },
    ];
    for (const mutate of mutations) {
      const directory = await root();
      const store = await initializeFilesystemTargetLocalBundleStore(directory);
      await store.reserve(request());
      await mutate(directory, stateFile(directory));
      await expect(store.lookup({ idempotency_key: request().idempotency_key, request_digest: digest("0") }))
        .rejects.toThrow("Target-local container bundle store failed");
    }

    const deniedDirectory = await root();
    const denied = await initializeFilesystemTargetLocalBundleStore(deniedDirectory);
    await chmod(deniedDirectory, 0o500);
    try {
      await expect(denied.reserve(request())).rejects.toThrow("Target-local container bundle store failed");
    } finally {
      await chmod(deniedDirectory, 0o700);
    }
    expect(await readdir(deniedDirectory)).toContain("archives");
  });
});
