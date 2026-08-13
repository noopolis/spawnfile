import { describe, expect, it, vi } from "vitest";

import { createTargetLocalContainerBundleOperations } from "./containerBundle.js";
import { createContainerBundlePreparationAuthority } from "./containerBundleAuthority.js";
import {
  deriveTargetLocalContainerBundlePolicy,
  TARGET_LOCAL_CONTAINER_BUNDLE_POLICY,
} from "./containerBundlePolicy.js";
import { parseTargetLocalBundlePrepareRequest } from "./containerBundleContracts.js";
import { createMemoryTargetLocalBundleStore } from "./containerBundleStore.js";

const input = Object.freeze({
  archiveDigest: `sha256:${"a".repeat(64)}`,
  artifactDigest: `sha256:${"b".repeat(64)}`,
  baseImageConfigDigest: `sha256:${"c".repeat(64)}`,
  bundleDigest: `sha256:${"d".repeat(64)}`,
  entrypoint: "runtime/runner.mjs",
  launcherDigest: `sha256:${"e".repeat(64)}`,
  networkAlias: "world",
  platform: Object.freeze({ architecture: "amd64" as const, os: "linux" as const })
});

describe("target-local container bundle policy", () => {
  it("freezes and derives deterministic policy and platform commitments", () => {
    const first = deriveTargetLocalContainerBundlePolicy(input);
    expect(Object.isFrozen(TARGET_LOCAL_CONTAINER_BUNDLE_POLICY)).toBe(true);
    expect(Object.isFrozen(TARGET_LOCAL_CONTAINER_BUNDLE_POLICY.builder)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual(deriveTargetLocalContainerBundlePolicy(input));
    expect(first.buildPolicyDigest).not.toBe(first.platformDigest);
  });

  it("binds builder claims and rejects unsupported platforms or unsafe entrypoints", () => {
    expect(deriveTargetLocalContainerBundlePolicy({
      ...input,
      baseImageConfigDigest: `sha256:${"f".repeat(64)}`,
    })).not.toEqual(deriveTargetLocalContainerBundlePolicy(input));
    expect(() => deriveTargetLocalContainerBundlePolicy({
      ...input,
      entrypoint: "../runner.mjs",
    })).toThrow("Target-local container bundle policy failed");
    expect(() => deriveTargetLocalContainerBundlePolicy({
      ...input,
      platform: { architecture: "amd64", os: "darwin" } as never,
    })).toThrow("Target-local container bundle policy failed");
    expect(deriveTargetLocalContainerBundlePolicy({
      ...input, platform: { architecture: "arm64", os: "linux" }
    }).platformDigest).not.toBe(
      deriveTargetLocalContainerBundlePolicy(input).platformDigest,
    );
  });

  it("recomputes both commitments from the complete private tuple before authorization", async () => {
    const derived = deriveTargetLocalContainerBundlePolicy(input);
    const request = parseTargetLocalBundlePrepareRequest({
      archive_base64: "YQ==", archive_digest: input.archiveDigest,
      archive_entries: [input.entrypoint], artifact_digest: input.artifactDigest,
      build_policy_digest: derived.buildPolicyDigest, bundle_digest: input.bundleDigest,
      entrypoint: input.entrypoint, idempotency_key: "idem_abcdefghijklmnop",
      launcher_digest: input.launcherDigest, network_alias: input.networkAlias,
      platform: input.platform, platform_digest: derived.platformDigest,
      selected_target: { fingerprint: `sha256:${"1".repeat(32)}`, handle: `opaque_${"a".repeat(32)}` },
      version: "spawnfile.target-local-container-bundle.prepare-request.v1"
    });
    const authority = createContainerBundlePreparationAuthority([{
      archive_digest: input.archiveDigest, artifact_manifest_digest: input.artifactDigest,
      base_image_config_digest: input.baseImageConfigDigest,
      build_policy_digest: derived.buildPolicyDigest, bundle_digest: input.bundleDigest,
      entrypoint: input.entrypoint, launcher_digest: input.launcherDigest,
      network_alias: input.networkAlias, platform: input.platform, platform_digest: derived.platformDigest
    }]);
    expect(authority.authorize(request)).toMatchObject({ base_image_config_digest: input.baseImageConfigDigest });
    expect(() => authority.authorize({
      ...request, build_policy_digest: `sha256:${"f".repeat(64)}`
    })).toThrow("Target-local container bundle authorization failed");
    expect(() => authority.authorize({
      ...request, platform_digest: `sha256:${"f".repeat(64)}`
    })).toThrow("Target-local container bundle authorization failed");
    const store = createMemoryTargetLocalBundleStore();
    const reserve = vi.fn(store.reserve);
    const guardedStore = { ...store, reserve };
    const builder = {
      attestTarget: vi.fn(), build: vi.fn(), inspect: vi.fn(), inspectAnchor: vi.fn()
    };
    const operations = createTargetLocalContainerBundleOperations({ authority, builder, store: guardedStore });
    await expect(operations.prepare({
      ...request, build_policy_digest: `sha256:${"f".repeat(64)}`
    })).rejects.toThrow("Target-local container bundle authorization failed");
    expect(reserve).not.toHaveBeenCalled();
    expect(builder.attestTarget).not.toHaveBeenCalled();
  });
});
