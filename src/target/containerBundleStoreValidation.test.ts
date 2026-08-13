import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTargetLocalBundleReceiptDigest,
  createTargetLocalBundleRequestDigest,
  type TargetLocalBundlePrepareReceipt,
  type TargetLocalBundlePrepareRequest,
} from "./containerBundleContracts.js";
import {
  createMemoryTargetLocalBundleStore,
  type TargetLocalBundleLease,
  type TargetLocalBundleMemoryStore,
  type TargetLocalBundlePrivateMapping,
} from "./containerBundleStore.js";
import { parseOpaqueTargetHandle, type OpaqueTargetHandle } from "./contracts.js";

const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const request = (idempotency = "idem_abcdefghijklmnop", changes: Partial<TargetLocalBundlePrepareRequest> = {}): TargetLocalBundlePrepareRequest => ({
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
  ...changes,
});
const gcTag = (requestDigest: string): string => `spfb_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.gc-tag.v1\0", "utf8").update(requestDigest).digest("hex").slice(0, 58)}`;
const mappingHandle = (operation: OpaqueTargetHandle, requestDigest: string): OpaqueTargetHandle => parseOpaqueTargetHandle(`opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.mapping.v1\0", "utf8").update(`${operation}\0${requestDigest}`, "utf8").digest("hex")}`);
const mapping = (input: TargetLocalBundlePrepareRequest, operation: OpaqueTargetHandle, requestDigest: string): TargetLocalBundlePrivateMapping => ({
  archive_digest: input.archive_digest,
  artifact_digest: input.artifact_digest,
  base_image_config_digest: digest("9"),
  build_policy_digest: input.build_policy_digest,
  bundle_digest: input.bundle_digest,
  config_id: digest("8"),
  daemon_epoch: digest("7"),
  entrypoint: input.entrypoint,
  gc_tag: gcTag(requestDigest),
  identity_kind: "docker_image_config_digest",
  launcher_digest: input.launcher_digest,
  network_alias: input.network_alias,
  operation_handle: operation,
  platform: input.platform,
  platform_digest: input.platform_digest,
  request_digest: requestDigest,
  selected_target: input.selected_target,
});
const receipt = (
  input: TargetLocalBundlePrepareRequest,
  operation: OpaqueTargetHandle,
  requestDigest: string,
  changes: Partial<TargetLocalBundlePrepareReceipt> = {},
): TargetLocalBundlePrepareReceipt => {
  const raw = {
    archive_digest: input.archive_digest,
    artifact_digest: input.artifact_digest,
    build_policy_digest: input.build_policy_digest,
    bundle_digest: input.bundle_digest,
    launcher_digest: input.launcher_digest,
    mapping_handle: mappingHandle(operation, requestDigest),
    network_alias: input.network_alias,
    operation_handle: operation,
    platform: input.platform,
    platform_digest: input.platform_digest,
    receipt_digest: digest("0"),
    request_digest: requestDigest,
    selected_target: input.selected_target,
    version: "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const,
    ...changes,
  };
  return { ...raw, receipt_digest: createTargetLocalBundleReceiptDigest(raw) };
};
const owner = async (store: TargetLocalBundleMemoryStore, input: TargetLocalBundlePrepareRequest) => {
  const reserved = await store.reserve(input);
  if (reserved.kind !== "owner") throw new Error("expected owner");
  return reserved;
};
const complete = async (store: TargetLocalBundleMemoryStore, input: TargetLocalBundlePrepareRequest) => {
  const reserved = await owner(store, input);
  const inflight = await store.beginBuild({ lease: reserved.lease });
  const value = mapping(input, reserved.operation_handle, reserved.request_digest);
  const postbuild = await store.stagePostbuild({ lease: inflight, mapping: value });
  const done = await store.complete({ lease: postbuild, mapping: value, receipt: receipt(input, reserved.operation_handle, reserved.request_digest) });
  return { mapping: value, owner: reserved, receipt: done };
};

afterEach(() => vi.useRealTimers());

describe("container bundle memory-store validation", () => {
  it("rejects malformed leases and private mappings before state mutation", async () => {
    const store = createMemoryTargetLocalBundleStore();
    const input = request();
    const reserved = await owner(store, input);
    const invalidLeases: unknown[] = [
      null,
      [],
      { ...reserved.lease, extra: true },
      { ...reserved.lease, generation: 0 },
      { ...reserved.lease, generation: 1.5 },
      { ...reserved.lease, lease_id: "bad" },
      { ...reserved.lease, request_digest: "bad" },
      { ...reserved.lease, operation_handle: "bad" },
    ];
    for (const value of invalidLeases) await expect(store.beginBuild({ lease: value })).rejects.toThrow();

    const inflight = await store.beginBuild({ lease: reserved.lease });
    const valid = mapping(input, reserved.operation_handle, reserved.request_digest);
    const invalidMappings: unknown[] = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, archive_digest: "bad" },
      { ...valid, artifact_digest: "bad" },
      { ...valid, base_image_config_digest: "bad" },
      { ...valid, build_policy_digest: "bad" },
      { ...valid, bundle_digest: "bad" },
      { ...valid, config_id: "bad" },
      { ...valid, daemon_epoch: "bad" },
      { ...valid, entrypoint: "../bad" },
      { ...valid, gc_tag: "bad" },
      { ...valid, identity_kind: "other" },
      { ...valid, launcher_digest: "bad" },
      { ...valid, network_alias: "BAD" },
      { ...valid, platform_digest: "bad" },
      { ...valid, request_digest: "bad" },
      { ...valid, operation_handle: "bad" },
      { ...valid, platform: { architecture: "s390x", os: "linux" } },
      { ...valid, selected_target: null },
    ];
    for (const value of invalidMappings) await expect(store.stagePostbuild({ lease: inflight, mapping: value as never })).rejects.toThrow();

    const correlationDrifts: TargetLocalBundlePrivateMapping[] = [
      { ...valid, gc_tag: `spfb_${"0".repeat(58)}` },
      { ...valid, operation_handle: parseOpaqueTargetHandle(`opaque_${"b".repeat(32)}`) },
      { ...valid, request_digest: digest("0") },
      { ...valid, archive_digest: digest("1") },
      { ...valid, artifact_digest: digest("2") },
      { ...valid, build_policy_digest: digest("3") },
      { ...valid, bundle_digest: digest("4") },
      { ...valid, entrypoint: "other.mjs" },
      { ...valid, launcher_digest: digest("5") },
      { ...valid, network_alias: "other" },
      { ...valid, platform: { architecture: "arm64", os: "linux" } },
      { ...valid, platform_digest: digest("6") },
      { ...valid, selected_target: { ...valid.selected_target, fingerprint: `sha256:${"2".repeat(32)}` } },
    ];
    for (const value of correlationDrifts) await expect(store.stagePostbuild({ lease: inflight, mapping: value })).rejects.toThrow("Container bundle store failed");
    await expect(store.stagePostbuild({ lease: inflight, mapping: valid })).resolves.toMatchObject({ generation: 1 });
  });

  it("rejects every receipt correlation before completing", async () => {
    const store = createMemoryTargetLocalBundleStore();
    const input = request();
    const reserved = await owner(store, input);
    const inflight = await store.beginBuild({ lease: reserved.lease });
    const value = mapping(input, reserved.operation_handle, reserved.request_digest);
    const postbuild = await store.stagePostbuild({ lease: inflight, mapping: value });
    const otherHandle = parseOpaqueTargetHandle(`opaque_${"c".repeat(32)}`);
    const drifts: Array<Partial<TargetLocalBundlePrepareReceipt>> = [
      { mapping_handle: otherHandle },
      { operation_handle: otherHandle },
      { request_digest: digest("0") },
      { archive_digest: digest("1") },
      { artifact_digest: digest("2") },
      { build_policy_digest: digest("3") },
      { bundle_digest: digest("4") },
      { launcher_digest: digest("5") },
      { network_alias: "other" },
      { platform: { architecture: "arm64", os: "linux" } },
      { platform_digest: digest("6") },
      { selected_target: { ...input.selected_target, fingerprint: `sha256:${"2".repeat(32)}` } },
    ];
    for (const drift of drifts) {
      await expect(store.complete({ lease: postbuild, mapping: value, receipt: receipt(input, reserved.operation_handle, reserved.request_digest, drift) }))
        .rejects.toThrow("Container bundle store failed");
    }
    await expect(store.complete({ lease: postbuild, mapping: value, receipt: receipt(input, reserved.operation_handle, reserved.request_digest) }))
      .resolves.toMatchObject({ operation_handle: reserved.operation_handle });
  });

  it("covers incomplete, lookup, resolve, and replay-input states", async () => {
    const store = createMemoryTargetLocalBundleStore();
    const input = request();
    const reserved = await owner(store, input);
    await expect(store.markIncomplete({ lease: reserved.lease, operation_handle: "bad", request_digest: reserved.request_digest })).rejects.toThrow();
    await expect(store.markIncomplete({ lease: reserved.lease, operation_handle: reserved.operation_handle, request_digest: "bad" })).rejects.toThrow();
    await store.markIncomplete({ lease: reserved.lease, operation_handle: reserved.operation_handle, request_digest: reserved.request_digest });
    await expect(store.reserve(input)).resolves.toMatchObject({ kind: "incomplete" });
    await expect(store.lookup({ idempotency_key: input.idempotency_key, request_digest: reserved.request_digest })).resolves.toMatchObject({ status: "not_applied" });
    await expect(store.resolve({ operation_handle: reserved.operation_handle, request_digest: reserved.request_digest })).resolves.toBeNull();
    await expect(store.resolve({ operation_handle: "bad", request_digest: reserved.request_digest })).rejects.toThrow();
    await expect(store.lookup({ idempotency_key: null, request_digest: reserved.request_digest })).rejects.toThrow();
    await expect(store.lookup({ idempotency_key: input.idempotency_key, request_digest: null })).rejects.toThrow();
    await expect(store.lookup({ idempotency_key: "idem_missingmissing", request_digest: digest("0") })).resolves.toMatchObject({ status: "not_applied" });

    const replayInputs: unknown[] = [null, [], {}, { idempotency_key: "bad", maximum_wait_ms: 0, request_digest: digest("0") },
      { idempotency_key: "idem_abcdefghijklmnop", maximum_wait_ms: 0, request_digest: "bad" },
      { idempotency_key: "idem_abcdefghijklmnop", maximum_wait_ms: -1, request_digest: digest("0") },
      { idempotency_key: "idem_abcdefghijklmnop", maximum_wait_ms: 1.5, request_digest: digest("0") }];
    for (const value of replayInputs) await expect(store.awaitReplay(value as never)).rejects.toThrow("Container bundle store failed");
  });

  it("reclaims expired prebuild and postbuild leases with and without a mapping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const input = request();
    const prebuildStore = createMemoryTargetLocalBundleStore();
    const first = await owner(prebuildStore, input);
    vi.advanceTimersByTime(30_001);
    await expect(prebuildStore.reserve(input)).resolves.toMatchObject({ kind: "owner", state: "prebuild", lease: { generation: first.lease.generation + 1 } });

    const postbuildStore = createMemoryTargetLocalBundleStore();
    const postOwner = await owner(postbuildStore, input);
    const inflight = await postbuildStore.beginBuild({ lease: postOwner.lease });
    const value = mapping(input, postOwner.operation_handle, postOwner.request_digest);
    await postbuildStore.stagePostbuild({ lease: inflight, mapping: value });
    vi.advanceTimersByTime(30_001);
    await expect(postbuildStore.reserve(input)).resolves.toMatchObject({ kind: "owner", state: "postbuild", mapping: value });
  });

  it("enforces capacity and rejects same-key semantic drift", async () => {
    const driftStore = createMemoryTargetLocalBundleStore();
    await driftStore.reserve(request());
    await expect(driftStore.reserve(request("idem_abcdefghijklmnop", { network_alias: "other" }))).rejects.toThrow("Container bundle store failed");

    const store = createMemoryTargetLocalBundleStore();
    for (let index = 0; index < 128; index += 1) {
      await store.reserve(request(`idem_${index.toString(36).padStart(16, "0")}`));
    }
    await expect(store.reserve(request("idem_capacitycapacity"))).rejects.toThrow("Container bundle store failed");
  });

  it("validates exact prepared resolution and rejects ambiguous matches", async () => {
    const store = createMemoryTargetLocalBundleStore();
    const firstInput = request("idem_abcdefghijklmnop");
    const first = await complete(store, firstInput);
    const query = { artifact_digest: firstInput.artifact_digest, build_policy_digest: firstInput.build_policy_digest,
      bundle_digest: firstInput.bundle_digest, selected_target: firstInput.selected_target };
    await expect(store.resolvePrepared(query)).resolves.toEqual({ mapping: first.mapping, request: firstInput });
    await expect(store.resolvePrepared({ ...query, artifact_digest: digest("0") })).resolves.toBeNull();
    await expect(store.resolvePrepared(null as never)).rejects.toThrow("Container bundle store failed");
    await expect(store.resolvePrepared([] as never)).rejects.toThrow("Container bundle store failed");
    await expect(store.resolvePrepared({ ...query, extra: true } as never)).rejects.toThrow("Container bundle store failed");

    await complete(store, request("idem_qrstuvwxyzabcdef"));
    await expect(store.resolvePrepared(query)).rejects.toThrow("Container bundle store failed");
    await expect(store.resolve({ operation_handle: first.owner.operation_handle, request_digest: first.owner.request_digest })).resolves.toEqual(first.mapping);
  });

  it("rejects corrupted snapshots across every durable state invariant", async () => {
    const prebuildStore = createMemoryTargetLocalBundleStore();
    await prebuildStore.reserve(request());
    const prebuild = prebuildStore.snapshot()[0]!;
    const completedStore = createMemoryTargetLocalBundleStore();
    await complete(completedStore, request());
    const completed = completedStore.snapshot()[0]!;
    const malformed: unknown[] = [
      null,
      [],
      { ...prebuild, state: "unknown" },
      { ...prebuild, extra: true },
      { ...prebuild, generation: 0 },
      { ...prebuild, request_digest: "bad" },
      { ...prebuild, idempotency_key: "idem_qrstuvwxyzabcdef" },
      { ...prebuild, operation_handle: parseOpaqueTargetHandle(`opaque_${"f".repeat(32)}`) },
      { ...prebuild, lease_id: null },
      { ...prebuild, lease_expires_at: null },
      { ...completed, lease_id: "lease_00000000000000000000000000000000" },
      { ...completed, lease_expires_at: 1 },
      Object.fromEntries(Object.entries(completed).filter(([key]) => key !== "mapping")),
      Object.fromEntries(Object.entries(completed).filter(([key]) => key !== "receipt")),
      { ...completed, mapping: { ...completed.mapping!, gc_tag: `spfb_${"0".repeat(58)}` } },
      { ...completed, receipt: receipt(completed.request, completed.operation_handle, completed.request_digest, { operation_handle: parseOpaqueTargetHandle(`opaque_${"e".repeat(32)}`) }) },
    ];
    for (const value of malformed) {
      const restored = createMemoryTargetLocalBundleStore();
      expect(() => restored.restore([value])).toThrow();
    }
    const duplicate = createMemoryTargetLocalBundleStore();
    expect(() => duplicate.restore([prebuild, prebuild])).toThrow("Container bundle store failed");
  });
});
