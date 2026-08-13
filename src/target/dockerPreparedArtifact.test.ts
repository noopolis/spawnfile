import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTargetLocalBundleReceiptDigest,
  createTargetLocalBundleRequestDigest,
  type TargetLocalBundlePrepareRequest
} from "./containerBundleContracts.js";
import { createMemoryTargetLocalBundleStore } from "./containerBundleStore.js";
import { attestTargetLocalBundleMapping, createTargetLocalContainerBundleOperations, targetLocalBundleGcTag, targetLocalBundleLabels, type DockerTargetLocalBundleBuilder } from "./containerBundle.js";
import { createContainerBundlePreparationAuthority } from "./containerBundleAuthority.js";
import { deriveTargetLocalContainerBundlePolicy } from "./containerBundlePolicy.js";
import { SELECTED_TARGET_VERSION, TARGET_RESOURCE_REQUEST_VERSION, parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerConfigArtifactSpec, initializeDockerArtifactIdentityStore } from "./dockerArtifactsProvider.js";
import { attestPreparedArtifactIdentity, createDockerPreparedArtifactOperations } from "./dockerPreparedArtifact.js";
import { initializeTargetJournal } from "./journal.js";

const digest = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const handle = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(16)}`);
const gcTag = (requestDigest: string): string => `spfb_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.gc-tag.v1\0", "utf8").update(requestDigest).digest("hex").slice(0, 58)}`;
const mappingHandle = (operation: string, requestDigest: string) => parseOpaqueTargetHandle(`opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.mapping.v1\0", "utf8").update(`${operation}\0${requestDigest}`, "utf8").digest("hex")}`);
const selected = { fingerprint: `sha256:${"f".repeat(32)}`, handle: handle("t") };
const manifest = digest("a"); const bundle = digest("b"); const policy = digest("c");
const configId = digest("d"); const archive = digest("e"); const base = digest("f"); const daemon = digest("1");
const launcher = digest("2"); const platformDigest = digest("3"); const platform = { architecture: "amd64", os: "linux" } as const; const roots: string[] = [];
const block = 512;
const octal = (value: number, width: number): Buffer => Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
const archiveFor = (entries: readonly { readonly body: string; readonly path: string }[]): Buffer => {
  const output: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(block); const bytes = Buffer.from(entry.body);
    header.set(Buffer.from(entry.path)); header.set(octal(0o644, 8), 100); header.set(octal(bytes.byteLength, 12), 124);
    header.set(octal(0, 8), 108); header.set(octal(0, 8), 116); header.set(octal(0, 12), 136); header[156] = 48;
    header.set(Buffer.from("ustar\0", "ascii"), 257); header.set(Buffer.from("00", "ascii"), 263); header.fill(0x20, 148, 156);
    let sum = 0; for (const byte of header) sum += byte; header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
    output.push(header, bytes, Buffer.alloc((block - bytes.byteLength % block) % block));
  }
  return Buffer.concat([...output, Buffer.alloc(block * 2)]);
};
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

const prepareRequest = (): TargetLocalBundlePrepareRequest => ({
  archive_base64: "YQ==", archive_digest: archive, archive_entries: ["bundle.json"],
  artifact_digest: manifest, build_policy_digest: policy, bundle_digest: bundle, entrypoint: "bundle.json",
  idempotency_key: "idem_aaaaaaaaaaaaaaaa", launcher_digest: launcher, network_alias: "world",
  platform, platform_digest: platformDigest, selected_target: selected,
  version: "spawnfile.target-local-container-bundle.prepare-request.v1"
});
const completePrepared = async () => {
  const store = createMemoryTargetLocalBundleStore(); const request = prepareRequest(); const reserved = await store.reserve(request);
  if (reserved.kind !== "owner") throw new Error("owner expected");
  const receiptBody = {
    archive_digest: request.archive_digest, artifact_digest: request.artifact_digest,
    build_policy_digest: request.build_policy_digest, bundle_digest: request.bundle_digest, launcher_digest: request.launcher_digest,
    mapping_handle: mappingHandle(reserved.operation_handle, reserved.request_digest), network_alias: request.network_alias, operation_handle: reserved.operation_handle,
    platform: request.platform, platform_digest: request.platform_digest, receipt_digest: digest("0"),
    request_digest: reserved.request_digest, selected_target: request.selected_target,
    version: "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const
  };
  const receipt = { ...receiptBody, receipt_digest: createTargetLocalBundleReceiptDigest(receiptBody) };
  const mapping = { archive_digest: archive, artifact_digest: manifest, base_image_config_digest: base,
    build_policy_digest: policy, bundle_digest: bundle, config_id: configId, daemon_epoch: daemon,
    entrypoint: "bundle.json", gc_tag: gcTag(reserved.request_digest), identity_kind: "docker_image_config_digest" as const,
    launcher_digest: launcher, network_alias: "world", operation_handle: reserved.operation_handle,
    platform, platform_digest: platformDigest, request_digest: reserved.request_digest, selected_target: selected };
  const inflight = await store.beginBuild({ lease: reserved.lease }); const postbuild = await store.stagePostbuild({ lease: inflight, mapping });
  await store.complete({ lease: postbuild, mapping, receipt });
  return store;
};
const artifactRequest = () => ({ artifact_manifest_digest: manifest, descriptor_digest: digest("9"),
  expected_revision: 0, idempotency_key: "idem_bbbbbbbbbbbbbbbb", operation: "resolve_world_artifact",
  run_id: "run-prepared", selected_target: selected, version: TARGET_RESOURCE_REQUEST_VERSION });
const builder = (input: { readonly daemonEpoch?: string; readonly inspect?: boolean; readonly overwrite?: boolean } = {}): DockerTargetLocalBundleBuilder => Object.freeze({
  attestTarget: async () => ({ daemon_epoch: input.daemonEpoch ?? daemon }),
  build: async () => { throw new Error("not used"); },
  inspect: async (value: Parameters<DockerTargetLocalBundleBuilder["inspect"]>[0]) => input.inspect === false ? null : ({ config_id: value.config_id, labels: input.overwrite ? {} : value.labels, platform: value.platform }),
  inspectAnchor: async () => "missing" as const
});
const withAuthoritativePolicy = <T extends TargetLocalBundlePrepareRequest>(request: T): T => {
  const derived = deriveTargetLocalContainerBundlePolicy({
    archiveDigest: request.archive_digest, artifactDigest: request.artifact_digest,
    baseImageConfigDigest: base, bundleDigest: request.bundle_digest, entrypoint: request.entrypoint,
    launcherDigest: request.launcher_digest, networkAlias: request.network_alias, platform: request.platform
  });
  return { ...request, build_policy_digest: derived.buildPolicyDigest, platform_digest: derived.platformDigest };
};

describe("prepared local Docker artifact authority", () => {
  it("resolves only the exact selected-target/manifest/bundle/policy mapping", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prepared-artifact-"))); roots.push(root);
    const store = await completePrepared(); const request = artifactRequest();
    const journal = await initializeTargetJournal({ context: "target_1", descriptorDigest: request.descriptor_digest,
      root: path.join(root, "journal"), runId: request.run_id,
      selectedTarget: { ...selected, version: SELECTED_TARGET_VERSION } });
    const identities = await initializeDockerArtifactIdentityStore(path.join(root, "identities"));
    const result = await createDockerPreparedArtifactOperations({ builder: builder(), identityStore: identities, journal,
      mapping: { archive_digest: archive, artifact_manifest_digest: manifest, base_image_config_digest: base,
        build_policy_digest: policy, bundle_digest: bundle, entrypoint: "bundle.json", launcher_digest: launcher,
        network_alias: "world", platform, platform_digest: platformDigest }, store }).execute(request);
    const entry = (await journal.read()).entries[0]!;
    const bound = await identities.resolveOperation(entry.operation_handle, entry.request_digest);
    const exact = createDockerConfigArtifactSpec({ archiveDigest: archive, artifactManifestDigest: manifest,
      baseImageConfigDigest: base, buildPolicyDigest: policy, bundleDigest: bundle, configId, daemonEpoch: daemon,
      entrypoint: "bundle.json", launcherDigest: launcher, networkAlias: "world", operationHandle: entry.operation_handle,
      requestDigest: entry.request_digest, selectedTargetHandle: selected.handle, platform, platformDigest });
    expect(result.receipt.result_handle).toBe(exact.resultHandle);
    expect(bound).toEqual(expect.objectContaining({ configId, identityKind: "docker_image_config_digest",
      preparedOperationHandle: expect.any(String), preparedRequestDigest: expect.any(String),
      resultHandle: exact.resultHandle }));
    if (!bound || bound.identityKind !== "docker_image_config_digest") throw new Error("config binding expected");
    const prepared = await store.resolvePrepared({ artifact_digest: manifest, build_policy_digest: policy,
      bundle_digest: bundle, selected_target: selected });
    expect(bound.preparedOperationHandle).toBe(prepared?.mapping.operation_handle);
    expect(bound.preparedRequestDigest).toBe(prepared?.mapping.request_digest);
    expect(bound.operationHandle).toBe(entry.operation_handle);
    expect(bound.requestDigest).toBe(entry.request_digest);
    const replay = await createDockerPreparedArtifactOperations({ builder: builder(), identityStore: identities, journal,
      mapping: { archive_digest: archive, artifact_manifest_digest: manifest, base_image_config_digest: base,
        build_policy_digest: policy, bundle_digest: bundle, entrypoint: "bundle.json", launcher_digest: launcher,
        network_alias: "world", platform, platform_digest: platformDigest }, store }).execute(request);
    expect(replay.receiptBytes).toBe(result.receiptBytes);
    for (const privateValue of [configId, daemon, base, gcTag((await journal.read()).entries[0]!.request_digest)]) {
      expect(`${result.receiptBytes}${replay.receiptBytes}`).not.toContain(privateValue);
    }
    await expect(createDockerPreparedArtifactOperations({ builder: builder(), identityStore: identities, journal,
      mapping: { archive_digest: archive, artifact_manifest_digest: manifest, base_image_config_digest: base,
        build_policy_digest: digest("4"), bundle_digest: bundle, entrypoint: "bundle.json", launcher_digest: launcher,
        network_alias: "world", platform, platform_digest: platformDigest }, store })
      .execute({ ...request, idempotency_key: "idem_cccccccccccccccc", expected_revision: 1 }))
      .rejects.toThrow("Docker artifact resolution failed");
  });

  it("keeps prepare-anchor provenance disjoint from resolve authorization and rejects cross-mixed anchors", async () => {
    const store = await completePrepared();
    const prepared = await store.resolvePrepared({ artifact_digest: manifest, build_policy_digest: policy,
      bundle_digest: bundle, selected_target: selected });
    if (!prepared) throw new Error("prepared mapping expected");
    const resolveOperation = handle("r"); const resolveRequest = digest("7");
    const identity = {
      archiveDigest: archive, artifactManifestDigest: manifest, baseImageConfigDigest: base,
      buildPolicyDigest: policy, bundleDigest: bundle, configId, daemonEpoch: daemon,
      entrypoint: "bundle.json", gcTag: prepared.mapping.gc_tag,
      identityKind: "docker_image_config_digest" as const, launcherDigest: launcher,
      networkAlias: "world", operationHandle: resolveOperation, platform, platformDigest,
      preparedOperationHandle: prepared.mapping.operation_handle,
      preparedRequestDigest: prepared.mapping.request_digest, requestDigest: resolveRequest,
      resultHandle: handle("u"), selectedTargetHandle: selected.handle
    };
    const exactBuilder: DockerTargetLocalBundleBuilder = Object.freeze({
      attestTarget: async () => ({ daemon_epoch: daemon }),
      build: async () => { throw new Error("not used"); },
      inspect: async (value: Parameters<DockerTargetLocalBundleBuilder["inspect"]>[0]) => value.config_id === configId
        && value.gc_tag === prepared.mapping.gc_tag
        && JSON.stringify(value.labels) === JSON.stringify(targetLocalBundleLabels(
          prepared.mapping, daemon, prepared.mapping.request_digest))
        ? { config_id: configId, labels: value.labels, platform } : null,
      inspectAnchor: async (): Promise<"missing"> => "missing"
    });
    await expect(attestPreparedArtifactIdentity(exactBuilder, identity, prepared.mapping, selected)).resolves.toBeUndefined();
    /* Resolve provenance may differ: it authorizes use but never remints the prepared anchor. */
    await expect(attestPreparedArtifactIdentity(exactBuilder, {
      ...identity, operationHandle: handle("z"), requestDigest: digest("8")
    }, prepared.mapping, selected)).resolves.toBeUndefined();
    for (const hostile of [
      { preparedOperationHandle: handle("x") },
      { preparedRequestDigest: digest("8") },
      { gcTag: gcTag(digest("8")) },
      { configId: digest("8") }
    ]) {
      await expect(attestPreparedArtifactIdentity(exactBuilder, {
        ...identity, ...hostile
      }, prepared.mapping, selected)).rejects.toThrow("Docker artifact resolution failed");
    }
  });

  it("does not treat an operation digest as a prepared mapping lookup key", async () => {
    const store = await completePrepared(); const request = prepareRequest();
    await expect(store.resolvePrepared({ artifact_digest: manifest, build_policy_digest: policy,
      bundle_digest: bundle, selected_target: { ...selected, handle: handle("x") } })).resolves.toBeNull();
    await expect(store.resolvePrepared({ artifact_digest: createTargetLocalBundleRequestDigest(request),
      build_policy_digest: policy, bundle_digest: bundle, selected_target: selected })).resolves.toBeNull();
  });

  it("fails closed before admission when the daemon changes or the exact GC anchor/config is lost", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prepared-artifact-hostile-"))); roots.push(root);
    const store = await completePrepared(); const request = artifactRequest();
    const journal = await initializeTargetJournal({ context: "target_1", descriptorDigest: request.descriptor_digest,
      root: path.join(root, "journal"), runId: request.run_id, selectedTarget: { ...selected, version: SELECTED_TARGET_VERSION } });
    const identities = await initializeDockerArtifactIdentityStore(path.join(root, "identities"));
    const mapping = { archive_digest: archive, artifact_manifest_digest: manifest, base_image_config_digest: base,
      build_policy_digest: policy, bundle_digest: bundle, entrypoint: "bundle.json", launcher_digest: launcher,
      network_alias: "world", platform, platform_digest: platformDigest };
    await expect(createDockerPreparedArtifactOperations({ builder: builder({ daemonEpoch: digest("4") }), identityStore: identities, journal, mapping, store }).execute(request)).rejects.toThrow("Docker artifact resolution failed");
    await expect(createDockerPreparedArtifactOperations({ builder: builder({ inspect: false }), identityStore: identities, journal, mapping, store }).execute(request)).rejects.toThrow("Docker artifact resolution failed");
  });

  it("keeps daemon replacement, tag overwrite, and config loss private and fail-closed", async () => {
    const store = await completePrepared(); const prepared = await store.resolvePrepared({ artifact_digest: manifest,
      build_policy_digest: policy, bundle_digest: bundle, selected_target: selected });
    if (!prepared) throw new Error("prepared mapping expected");
    await expect(attestTargetLocalBundleMapping(builder({ daemonEpoch: digest("4") }), prepared.mapping)).rejects.toThrow("Target-local container bundle preparation failed");
    await expect(attestTargetLocalBundleMapping(builder({ overwrite: true }), prepared.mapping)).rejects.toThrow("Target-local container bundle preparation failed");
    await expect(attestTargetLocalBundleMapping(builder({ inspect: false }), prepared.mapping)).rejects.toThrow("Target-local container bundle preparation failed");
    expect(JSON.stringify(prepared.mapping)).not.toContain("registry.example");
  });

  it("adopts an exact anchor after a build-before-stage crash and fences a missing-anchor retry", async () => {
    const initial = createMemoryTargetLocalBundleStore(); const prepare = withAuthoritativePolicy(prepareRequest()); const owner = await initial.reserve(prepare);
    if (owner.kind !== "owner") throw new Error("owner expected");
    await initial.beginBuild({ lease: owner.lease });
    const expired = initial.snapshot().map((record) => ({ ...record, lease_expires_at: 0 }));
    const store = createMemoryTargetLocalBundleStore(); store.restore(expired);
    const authority = createContainerBundlePreparationAuthority([{ archive_digest: archive, artifact_manifest_digest: manifest,
      base_image_config_digest: base, build_policy_digest: prepare.build_policy_digest, bundle_digest: bundle, entrypoint: "bundle.json",
      launcher_digest: launcher, network_alias: "world", platform, platform_digest: prepare.platform_digest }]);
    const labels = targetLocalBundleLabels({ archive_digest: archive, artifact_digest: manifest, base_image_config_digest: base,
      build_policy_digest: prepare.build_policy_digest, bundle_digest: bundle, entrypoint: "bundle.json", launcher_digest: launcher,
      network_alias: "world", platform_digest: prepare.platform_digest }, daemon, owner.request_digest);
    const exact: DockerTargetLocalBundleBuilder = Object.freeze({
      attestTarget: async () => ({ daemon_epoch: daemon }), build: async () => ({ config_id: configId, labels, platform }),
      inspect: async (value: Parameters<DockerTargetLocalBundleBuilder["inspect"]>[0]) => ({ config_id: value.config_id, labels: value.labels, platform: value.platform }),
      inspectAnchor: async () => ({ config_id: configId, labels, platform })
    });
    await expect(createTargetLocalContainerBundleOperations({ authority, builder: exact, store }).recover(prepare))
      .resolves.toMatchObject({ artifact_digest: manifest });
    expect((await store.resolve({ operation_handle: owner.operation_handle, request_digest: owner.request_digest }))?.gc_tag)
      .toBe(targetLocalBundleGcTag(owner.request_digest));
  });

  it("reattests an intact completed bundle and rebuilds the same request when its anchor is missing", async () => {
    const artifactBody = "replay artifact"; const launcherBody = "replay launcher";
    const artifactDigest = `sha256:${createHash("sha256").update(artifactBody).digest("hex")}`;
    const launcherDigest = `sha256:${createHash("sha256").update(launcherBody).digest("hex")}`;
    const bytes = archiveFor([
      { body: artifactBody, path: "artifact.bin" },
      { body: "{\"provider\":\"opaque\"}", path: "bundle.json" },
      { body: launcherBody, path: "launcher.mjs" }
    ]);
    const request = withAuthoritativePolicy({ ...prepareRequest(), archive_base64: bytes.toString("base64"),
      archive_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      archive_entries: ["artifact.bin", "bundle.json", "launcher.mjs"], artifact_digest: artifactDigest,
      entrypoint: "launcher.mjs", launcher_digest: launcherDigest });
    const authority = createContainerBundlePreparationAuthority([{ archive_digest: request.archive_digest,
      artifact_manifest_digest: artifactDigest, base_image_config_digest: base,
      build_policy_digest: request.build_policy_digest, bundle_digest: bundle, entrypoint: "launcher.mjs",
      launcher_digest: launcherDigest, network_alias: "world", platform, platform_digest: request.platform_digest }]);
    const store = createMemoryTargetLocalBundleStore(); let anchor: Parameters<DockerTargetLocalBundleBuilder["inspect"]>[0] | null = null;
    const build = vi.fn(async (value: Parameters<DockerTargetLocalBundleBuilder["build"]>[0]) => {
      anchor = { config_id: configId, gc_tag: value.gc_tag, labels: value.labels, platform: value.platform };
      return { config_id: configId, labels: value.labels, platform: value.platform };
    });
    const inspectAnchor = vi.fn(async () => anchor === null ? "missing" as const
      : { config_id: anchor.config_id, labels: anchor.labels, platform: anchor.platform });
    const exact: DockerTargetLocalBundleBuilder = Object.freeze({ attestTarget: async () => ({ daemon_epoch: daemon }), build,
      inspect: async (value: Parameters<DockerTargetLocalBundleBuilder["inspect"]>[0]) => anchor === null || value.config_id !== anchor.config_id || value.gc_tag !== anchor.gc_tag
        ? null : { config_id: value.config_id, labels: value.labels, platform: value.platform }, inspectAnchor });
    const operations = createTargetLocalContainerBundleOperations({ authority, builder: exact, store });
    const first = await operations.prepare(request); const intact = await operations.prepare(request);
    expect(intact).toEqual(first); expect(build).toHaveBeenCalledTimes(1); expect(inspectAnchor).toHaveBeenCalledTimes(1);
    const stale = await store.reserve(request); expect(stale.kind).toBe("replay");
    anchor = null;
    const rebuilt = await operations.prepare(request);
    expect(rebuilt).toEqual(first); expect(build).toHaveBeenCalledTimes(2);
    expect(store.snapshot()).toEqual([expect.objectContaining({ generation: 2, state: "completed" })]);
    if (stale.kind !== "replay") throw new Error("expected replay");
    await expect(store.retryMissingCompleted({ generation: stale.generation, operation_handle: stale.receipt.operation_handle,
      request_digest: stale.receipt.request_digest })).resolves.toMatchObject({ generation: 2, kind: "replay" });
    await expect(operations.recover(request)).resolves.toEqual(first); expect(build).toHaveBeenCalledTimes(2);
    anchor = null;
    await expect(operations.recover(request)).resolves.toEqual(first); expect(build).toHaveBeenCalledTimes(3);
    expect(store.snapshot()).toEqual([expect.objectContaining({ generation: 3, state: "completed" })]);
  });

  it("renews a live build lease before expiry and keeps a competing recovery fenced", async () => {
    vi.useFakeTimers();
    try {
      const artifactBody = "opaque artifact"; const launcherBody = "opaque launcher";
      const artifactDigest = `sha256:${createHash("sha256").update(artifactBody).digest("hex")}`;
      const launcherDigest = `sha256:${createHash("sha256").update(launcherBody).digest("hex")}`;
      const bytes = archiveFor([
        { body: artifactBody, path: "artifact.bin" },
        { body: "{\"provider\":\"opaque\"}", path: "bundle.json" },
        { body: launcherBody, path: "launcher.mjs" }
      ]);
      const request = withAuthoritativePolicy({ ...prepareRequest(), archive_base64: bytes.toString("base64"),
        archive_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        archive_entries: ["artifact.bin", "bundle.json", "launcher.mjs"], artifact_digest: artifactDigest,
        entrypoint: "launcher.mjs", launcher_digest: launcherDigest });
      const store = createMemoryTargetLocalBundleStore(); const authority = createContainerBundlePreparationAuthority([{ archive_digest: request.archive_digest,
        artifact_manifest_digest: artifactDigest, base_image_config_digest: base, build_policy_digest: request.build_policy_digest, bundle_digest: bundle,
        entrypoint: "launcher.mjs", launcher_digest: launcherDigest, network_alias: "world", platform, platform_digest: request.platform_digest }]);
      let finish: (() => void) | undefined; const done = new Promise<void>((resolve) => { finish = resolve; }); let renewals = 0;
      const renew = store.renew; const fenced = Object.freeze({ ...store,
        renew: async (value: Parameters<typeof store.renew>[0]) => { renewals += 1; return renew(value); } });
      const labels = targetLocalBundleLabels({ archive_digest: request.archive_digest, artifact_digest: artifactDigest, base_image_config_digest: base,
        build_policy_digest: request.build_policy_digest, bundle_digest: bundle, entrypoint: "launcher.mjs", launcher_digest: launcherDigest, network_alias: "world", platform_digest: request.platform_digest }, daemon, createTargetLocalBundleRequestDigest(request));
      const builder: DockerTargetLocalBundleBuilder = Object.freeze({ attestTarget: async () => ({ daemon_epoch: daemon }),
        build: async () => { await done; return { config_id: configId, labels, platform }; },
        inspect: async (value: Parameters<DockerTargetLocalBundleBuilder["inspect"]>[0]) =>
          ({ config_id: value.config_id, labels: value.labels, platform: value.platform }),
        inspectAnchor: async () => "missing" as const });
      const operations = createTargetLocalContainerBundleOperations({ authority, builder, store: fenced }); const pending = operations.prepare(request);
      await vi.advanceTimersByTimeAsync(5_001); await expect(operations.recover(request)).rejects.toThrow(); expect(renewals).toBeGreaterThan(0);
      finish!(); await expect(pending).resolves.toMatchObject({ artifact_digest: artifactDigest });
    } finally { vi.useRealTimers(); }
  });
});
