import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { createCanonicalTargetLocalBundleLookupBytes, createCanonicalTargetLocalBundleReceiptBytes, createTargetLocalBundleReceiptDigest, type TargetLocalBundlePrepareRequest } from "./containerBundleContracts.js";
import { createMemoryTargetLocalBundleStore } from "./containerBundleStore.js";
import { initializeFilesystemTargetLocalBundleStore } from "./containerBundleFilesystemStore.js";
import type { OpaqueTargetHandle } from "./contracts.js";
import { parseOpaqueTargetHandle } from "./contracts.js";

const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const gcTag = (requestDigest: string): string => `spfb_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.gc-tag.v1\0", "utf8").update(requestDigest).digest("hex").slice(0, 58)}`;
const mappingHandle = (operation: OpaqueTargetHandle, requestDigest: string): OpaqueTargetHandle => parseOpaqueTargetHandle(`opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.mapping.v1\0", "utf8").update(`${operation}\0${requestDigest}`, "utf8").digest("hex")}`);
const request = (): TargetLocalBundlePrepareRequest => ({
  archive_base64: "YQ==", archive_digest: "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb", archive_entries: ["vendor/runtime/start.mjs"], artifact_digest: digest("b"),
  build_policy_digest: digest("c"), bundle_digest: digest("d"), entrypoint: "vendor/runtime/start.mjs", idempotency_key: "idem_abcdefghijklmnop",
  launcher_digest: digest("e"), network_alias: "world", platform: { architecture: "amd64", os: "linux" }, platform_digest: digest("f"),
  selected_target: { fingerprint: `sha256:${"1".repeat(32)}`, handle: parseOpaqueTargetHandle(`opaque_${"a".repeat(32)}`) }, version: "spawnfile.target-local-container-bundle.prepare-request.v1"
});
const receipt = (input: TargetLocalBundlePrepareRequest, operation: OpaqueTargetHandle, requestDigest: string) => {
  const raw = { archive_digest: input.archive_digest, artifact_digest: input.artifact_digest, build_policy_digest: input.build_policy_digest,
    bundle_digest: input.bundle_digest, launcher_digest: input.launcher_digest, mapping_handle: mappingHandle(operation, requestDigest), network_alias: input.network_alias,
    operation_handle: operation, platform: input.platform, platform_digest: input.platform_digest, receipt_digest: digest("0"), request_digest: requestDigest,
    selected_target: input.selected_target, version: "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const };
  return { ...raw, receipt_digest: createTargetLocalBundleReceiptDigest(raw) };
};
const privateMapping = (input: TargetLocalBundlePrepareRequest, operation: OpaqueTargetHandle, requestDigest: string) => ({
  archive_digest: input.archive_digest, artifact_digest: input.artifact_digest, base_image_config_digest: digest("9"),
  build_policy_digest: input.build_policy_digest, bundle_digest: input.bundle_digest, config_id: digest("8"), daemon_epoch: digest("7"),
  entrypoint: input.entrypoint, gc_tag: gcTag(requestDigest), identity_kind: "docker_image_config_digest" as const,
  launcher_digest: input.launcher_digest, network_alias: input.network_alias, operation_handle: operation,
  platform: input.platform, platform_digest: input.platform_digest, request_digest: requestDigest, selected_target: input.selected_target
});

describe("container bundle store", () => {
  it("persists a leased prebuild/inflight/postbuild/completed transition", async () => {
    const store = createMemoryTargetLocalBundleStore(); const input = request(); const owner = await store.reserve(input);
    if (owner.kind !== "owner") throw new Error("expected owner");
    await expect(store.reserve(input)).resolves.toMatchObject({ kind: "pending", state: "prebuild" });
    const inflight = await store.beginBuild({ lease: owner.lease });
    const mapping = privateMapping(input, owner.operation_handle, owner.request_digest);
    const postbuild = await store.stagePostbuild({ lease: inflight, mapping });
    const done = await store.complete({ lease: postbuild, mapping, receipt: receipt(input, owner.operation_handle, owner.request_digest) });
    await expect(store.reserve(input)).resolves.toMatchObject({ kind: "replay", receipt: done });
    await expect(store.resolvePrepared({ artifact_digest: input.artifact_digest, build_policy_digest: input.build_policy_digest,
      bundle_digest: input.bundle_digest, selected_target: input.selected_target })).resolves.toMatchObject({ mapping });
    const restored = createMemoryTargetLocalBundleStore();
    restored.restore(store.snapshot());
    await expect(restored.reserve(input)).resolves.toMatchObject({ kind: "replay", receipt: done });
    const lookup = await restored.lookup({ idempotency_key: input.idempotency_key, request_digest: owner.request_digest });
    const publicBytes = `${createCanonicalTargetLocalBundleReceiptBytes(done)}${createCanonicalTargetLocalBundleLookupBytes(lookup)}`;
    for (const privateValue of [mapping.config_id, mapping.daemon_epoch, mapping.gc_tag,
      mapping.base_image_config_digest]) expect(publicBytes).not.toContain(privateValue);
  });

  it("restores strict private state without treating the record as an enumeration API", async () => {
    const source = createMemoryTargetLocalBundleStore(); const owner = await source.reserve(request());
    const restored = createMemoryTargetLocalBundleStore(); restored.restore(source.snapshot());
    await expect(restored.reserve(request())).resolves.toMatchObject({ kind: "pending", operation_handle: owner.kind === "owner" ? owner.operation_handle : undefined });
    expect(() => restored.restore([])).toThrow("Container bundle store failed");
  });

  it("provides a bounded, read-only replay join without reclaiming a live lease", async () => {
    const store = createMemoryTargetLocalBundleStore(); const input = request(); const owner = await store.reserve(input);
    if (owner.kind !== "owner") throw new Error("expected owner");
    await expect(store.awaitReplay({ idempotency_key: input.idempotency_key, maximum_wait_ms: 0, request_digest: owner.request_digest }))
      .resolves.toMatchObject({ status: "pending", operation_handle: owner.operation_handle });
    const waiting = store.awaitReplay({ idempotency_key: input.idempotency_key, maximum_wait_ms: 250, request_digest: owner.request_digest });
    const inflight = await store.beginBuild({ lease: owner.lease }); const mapping = privateMapping(input, owner.operation_handle, owner.request_digest);
    const postbuild = await store.stagePostbuild({ lease: inflight, mapping }); await store.complete({ lease: postbuild, mapping, receipt: receipt(input, owner.operation_handle, owner.request_digest) });
    await expect(waiting).resolves.toMatchObject({ status: "completed", receipt: { request_digest: owner.request_digest } });
    await expect(store.awaitReplay({ idempotency_key: input.idempotency_key, maximum_wait_ms: 30_001, request_digest: owner.request_digest })).rejects.toThrow("Container bundle store failed");
  });

  it("permits an expired inflight retry only through the reclaimed fenced lease", async () => {
    const store = createMemoryTargetLocalBundleStore(); const owner = await store.reserve(request());
    if (owner.kind !== "owner") throw new Error("expected owner");
    const inflight = await store.beginBuild({ lease: owner.lease });
    await expect(store.retryPrebuild({ lease: { ...inflight, generation: inflight.generation + 1 } })).rejects.toThrow();
    const retried = await store.retryPrebuild({ lease: inflight });
    await expect(store.beginBuild({ lease: retried })).resolves.toMatchObject({ operation_handle: owner.operation_handle });
  });

  it("durably persists a leased generation without writing a public mapping", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spawnfile-bundle-store-"));
    try {
      const first = await initializeFilesystemTargetLocalBundleStore(root); const owner = await first.reserve(request());
      expect(owner.kind).toBe("owner");
      const saved = JSON.parse(await readFile(path.join(root, "container-bundles.json"), "utf8")) as Record<string, unknown>;
      expect(saved.version).toBe("spawnfile.target-local-container-bundle.private.v2");
      expect(JSON.stringify(saved)).not.toContain("archive_base64");
      await expect(readFile(path.join(root, "archives", request().archive_digest.slice(7)), "utf8")).resolves.toBe("a");
      const second = await initializeFilesystemTargetLocalBundleStore(root);
      await expect(second.reserve(request())).resolves.toMatchObject({ kind: "pending", state: "prebuild" });
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  it("persists an exact four-megabyte archive and fails closed when the physical root changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spawnfile-bundle-store-")); const moved = `${root}-moved`;
    try {
      const bytes = Buffer.alloc(4_194_304, 97); const input = { ...request(), archive_base64: bytes.toString("base64"),
        archive_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
      const store = await initializeFilesystemTargetLocalBundleStore(root); await expect(store.reserve(input)).resolves.toMatchObject({ kind: "owner" });
      await expect(stat(path.join(root, "archives", input.archive_digest.slice(7)))).resolves.toMatchObject({ size: 4_194_304 });
      await rename(root, moved); await mkdir(root, { mode: 0o700 });
      await expect(store.lookup({ idempotency_key: input.idempotency_key, request_digest: createHash("sha256").update("different").digest("hex") })).rejects.toThrow("Target-local container bundle store failed");
    } finally { await rm(root, { force: true, recursive: true }); await rm(moved, { force: true, recursive: true }); }
  });
});
