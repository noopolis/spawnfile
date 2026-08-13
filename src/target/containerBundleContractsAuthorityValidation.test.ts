import { describe, expect, it } from "vitest";

import { createContainerBundlePreparationAuthority, type ContainerBundleAllowlistEntry } from "./containerBundleAuthority.js";
import {
  createTargetLocalBundleReceiptDigest,
  parseTargetLocalBundleLookup,
  parseTargetLocalBundleLookupRequest,
  parseTargetLocalBundlePrepareReceipt,
  parseTargetLocalBundlePrepareRequest,
  type TargetLocalBundlePrepareRequest,
} from "./containerBundleContracts.js";
import { deriveTargetLocalContainerBundlePolicy } from "./containerBundlePolicy.js";
import { parseOpaqueTargetHandle } from "./contracts.js";

const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const request = (changes: Partial<TargetLocalBundlePrepareRequest> = {}): TargetLocalBundlePrepareRequest => ({
  archive_base64: "YQ==",
  archive_digest: digest("a"),
  archive_entries: ["runtime/runner.mjs"],
  artifact_digest: digest("b"),
  build_policy_digest: digest("c"),
  bundle_digest: digest("d"),
  entrypoint: "runtime/runner.mjs",
  idempotency_key: "idem_abcdefghijklmnop",
  launcher_digest: digest("e"),
  network_alias: "world",
  platform: { architecture: "amd64", os: "linux" },
  platform_digest: digest("f"),
  selected_target: { fingerprint: `sha256:${"1".repeat(32)}`, handle: parseOpaqueTargetHandle(`opaque_${"a".repeat(32)}`) },
  version: "spawnfile.target-local-container-bundle.prepare-request.v1",
  ...changes,
});
const receipt = (input = request()) => {
  const raw = {
    archive_digest: input.archive_digest,
    artifact_digest: input.artifact_digest,
    build_policy_digest: input.build_policy_digest,
    bundle_digest: input.bundle_digest,
    launcher_digest: input.launcher_digest,
    mapping_handle: parseOpaqueTargetHandle(`opaque_${"b".repeat(32)}`),
    network_alias: input.network_alias,
    operation_handle: parseOpaqueTargetHandle(`opaque_${"c".repeat(32)}`),
    platform: input.platform,
    platform_digest: input.platform_digest,
    receipt_digest: digest("0"),
    request_digest: digest("9"),
    selected_target: input.selected_target,
    version: "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const,
  };
  return { ...raw, receipt_digest: createTargetLocalBundleReceiptDigest(raw) };
};
const policyInput = {
  archiveDigest: digest("a"),
  artifactDigest: digest("b"),
  baseImageConfigDigest: digest("9"),
  bundleDigest: digest("d"),
  entrypoint: "runtime/runner.mjs",
  launcherDigest: digest("e"),
  networkAlias: "world",
  platform: { architecture: "amd64" as const, os: "linux" as const },
};
const allowed = (): ContainerBundleAllowlistEntry => {
  const policy = deriveTargetLocalContainerBundlePolicy(policyInput);
  return {
    archive_digest: policyInput.archiveDigest,
    artifact_manifest_digest: policyInput.artifactDigest,
    base_image_config_digest: policyInput.baseImageConfigDigest,
    build_policy_digest: policy.buildPolicyDigest,
    bundle_digest: policyInput.bundleDigest,
    entrypoint: policyInput.entrypoint,
    launcher_digest: policyInput.launcherDigest,
    network_alias: policyInput.networkAlias,
    platform: policyInput.platform,
    platform_digest: policy.platformDigest,
  };
};
const authorizedRequest = (entry = allowed()): TargetLocalBundlePrepareRequest => request({
  archive_digest: entry.archive_digest,
  artifact_digest: entry.artifact_manifest_digest,
  build_policy_digest: entry.build_policy_digest,
  bundle_digest: entry.bundle_digest,
  entrypoint: entry.entrypoint,
  launcher_digest: entry.launcher_digest,
  network_alias: entry.network_alias,
  platform: entry.platform,
  platform_digest: entry.platform_digest,
});

describe("container bundle contract and authority validation", () => {
  it("validates long archive paths, canonical base64, correlations, and entrypoint admission", () => {
    const longPath = `${"a".repeat(101)}/runner.mjs`;
    expect(parseTargetLocalBundlePrepareRequest(request({ archive_entries: [longPath], entrypoint: longPath }))).toMatchObject({ entrypoint: longPath });

    for (const archive_base64 of ["YQ", "=AAA", "YQ=A", "Y===", "@@@@"]) {
      expect(() => parseTargetLocalBundlePrepareRequest(request({ archive_base64 }))).toThrow();
    }
    expect(() => parseTargetLocalBundlePrepareRequest(request({ archive_entries: ["z", "a"], entrypoint: "z" }))).toThrow();
    expect(() => parseTargetLocalBundlePrepareRequest(request({ archive_entries: ["a", "a"], entrypoint: "a" }))).toThrow();
    expect(() => parseTargetLocalBundlePrepareRequest(request({ artifact_digest: digest("a") }))).toThrow();
    expect(() => parseTargetLocalBundlePrepareRequest(request({ entrypoint: "other.mjs" }))).toThrow();
  });

  it("admits only ordinary request graphs without invoking accessors", () => {
    expect(() => parseTargetLocalBundlePrepareRequest(null)).toThrow();
    expect(() => parseTargetLocalBundlePrepareRequest([])).toThrow();
    expect(() => parseTargetLocalBundlePrepareRequest({ ...request(), archive_base64: undefined })).toThrow();
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, request());
    expect(parseTargetLocalBundlePrepareRequest(nullPrototype)).toMatchObject({ idempotency_key: request().idempotency_key });
    const accessor = { ...request() } as Record<string, unknown>;
    Object.defineProperty(accessor, "archive_base64", { enumerable: true, get: () => { throw new Error("must not run"); } });
    expect(() => parseTargetLocalBundlePrepareRequest(accessor)).toThrow();
  });

  it("rejects receipt and completed-lookup digest or correlation drift", () => {
    const valid = receipt();
    expect(parseTargetLocalBundlePrepareReceipt(valid)).toEqual(valid);
    expect(() => parseTargetLocalBundlePrepareReceipt({ ...valid, receipt_digest: digest("0") })).toThrow("Container bundle receipt failed");
    const lookup = { idempotency_key: request().idempotency_key, operation_handle: valid.operation_handle, receipt: valid,
      request_digest: valid.request_digest, status: "completed" as const, version: "spawnfile.target-local-container-bundle.lookup.v1" as const };
    expect(parseTargetLocalBundleLookup(lookup)).toEqual(lookup);
    expect(() => parseTargetLocalBundleLookup({ ...lookup, operation_handle: parseOpaqueTargetHandle(`opaque_${"d".repeat(32)}`) })).toThrow("Container bundle lookup failed");
    expect(() => parseTargetLocalBundleLookup({ ...lookup, request_digest: digest("8") })).toThrow("Container bundle lookup failed");
    expect(parseTargetLocalBundleLookupRequest({ idempotency_key: request().idempotency_key, request_digest: digest("9"),
      version: "spawnfile.target-local-container-bundle.lookup.v1" })).toMatchObject({ request_digest: digest("9") });
  });

  it("rejects malformed allowlist entry graphs and platform shapes", () => {
    const valid = allowed();
    const nonEnumerable = { ...valid };
    Object.defineProperty(nonEnumerable, "network_alias", { enumerable: false, value: valid.network_alias });
    const customPlatform = Object.assign(Object.create(null) as Record<string, unknown>, valid.platform);
    const malformed: unknown[] = [
      null,
      [],
      Object.assign(Object.create(null) as Record<string, unknown>, valid),
      nonEnumerable,
      { ...valid, extra: true },
      { ...valid, archive_digest: "bad" },
      { ...valid, entrypoint: "a//b" },
      { ...valid, entrypoint: "a/../b" },
      { ...valid, network_alias: "BAD" },
      { ...valid, platform: null },
      { ...valid, platform: [] },
      { ...valid, platform: customPlatform },
      { ...valid, platform: { ...valid.platform, extra: true } },
      { ...valid, platform: { architecture: "amd64", os: "darwin" } },
      { ...valid, platform: { architecture: "s390x", os: "linux" } },
    ];
    for (const value of malformed) expect(() => createContainerBundlePreparationAuthority([value as never])).toThrow("Target-local container bundle authorization failed");
    expect(() => createContainerBundlePreparationAuthority(null as never)).toThrow("Target-local container bundle authorization failed");
    expect(() => createContainerBundlePreparationAuthority(Array.from({ length: 33 }, () => valid))).toThrow("Target-local container bundle authorization failed");
    expect(() => createContainerBundlePreparationAuthority([valid, valid])).toThrow("Target-local container bundle authorization failed");
  });

  it("recomputes policy and platform commitments after an exact allowlist match", () => {
    const valid = allowed();
    const authority = createContainerBundlePreparationAuthority([valid]);
    expect(authority.authorize(authorizedRequest(valid))).toMatchObject({ base_image_config_digest: valid.base_image_config_digest });

    const badPolicy = { ...valid, build_policy_digest: digest("6") };
    expect(() => createContainerBundlePreparationAuthority([badPolicy]).authorize(authorizedRequest(badPolicy)))
      .toThrow("Target-local container bundle authorization failed");
    const badPlatform = { ...valid, platform_digest: digest("5") };
    expect(() => createContainerBundlePreparationAuthority([badPlatform]).authorize(authorizedRequest(badPlatform)))
      .toThrow("Target-local container bundle authorization failed");
  });
});
