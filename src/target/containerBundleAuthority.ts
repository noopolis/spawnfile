import type { TargetLocalBundlePrepareRequest } from "./containerBundleContracts.js";
import { deriveTargetLocalContainerBundlePolicy } from "./containerBundlePolicy.js";

export interface ContainerBundleAllowlistEntry {
  readonly archive_digest: string;
  readonly artifact_manifest_digest: string;
  readonly base_image_config_digest: string;
  readonly build_policy_digest: string;
  readonly bundle_digest: string;
  readonly entrypoint: string;
  readonly launcher_digest: string;
  readonly network_alias: string;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly platform_digest: string;
}
export interface AuthorizedContainerBundlePlan extends ContainerBundleAllowlistEntry {
  readonly artifact_digest: string;
}
export interface ContainerBundlePreparationAuthority {
  /** Returns private build inputs only after the complete semantic tuple matches. */
  authorize(request: TargetLocalBundlePrepareRequest): AuthorizedContainerBundlePlan;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const fail = (): never => { throw new Error("Target-local container bundle authorization failed"); };
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const entry = (raw: unknown): ContainerBundleAllowlistEntry => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some((value) => !value.enumerable || !("value" in value))) return fail();
  const value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "archive_digest\0artifact_manifest_digest\0base_image_config_digest\0build_policy_digest\0bundle_digest\0entrypoint\0launcher_digest\0network_alias\0platform\0platform_digest"
    || !Object.values(value).filter((item) => typeof item === "string").every((item) => typeof item === "string")
    || ![value.archive_digest, value.artifact_manifest_digest, value.base_image_config_digest, value.build_policy_digest,
      value.bundle_digest, value.launcher_digest, value.platform_digest].every((item) => typeof item === "string" && DIGEST.test(item))
    || typeof value.entrypoint !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(value.entrypoint)
    || value.entrypoint.includes("//") || value.entrypoint.split("/").some((part) => part === "." || part === "..")
    || typeof value.network_alias !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(value.network_alias)
    || !value.platform || typeof value.platform !== "object" || Array.isArray(value.platform)
    || Object.getPrototypeOf(value.platform) !== Object.prototype) return fail();
  const platform = value.platform as Record<string, unknown>;
  if (Object.keys(platform).sort().join("\0") !== "architecture\0os"
    || platform.os !== "linux" || (platform.architecture !== "amd64" && platform.architecture !== "arm64")) return fail();
  return Object.freeze({ archive_digest: value.archive_digest as string,
    artifact_manifest_digest: value.artifact_manifest_digest as string,
    base_image_config_digest: value.base_image_config_digest as string,
    build_policy_digest: value.build_policy_digest as string, bundle_digest: value.bundle_digest as string,
    entrypoint: value.entrypoint, launcher_digest: value.launcher_digest as string, network_alias: value.network_alias,
    platform: Object.freeze({ architecture: platform.architecture, os: platform.os }) as ContainerBundleAllowlistEntry["platform"],
    platform_digest: value.platform_digest as string });
};

/** A target may build only a complete, reviewed, target-local plan. */
export const createContainerBundlePreparationAuthority = (
  entries: readonly ContainerBundleAllowlistEntry[]
): ContainerBundlePreparationAuthority => {
  if (!Array.isArray(entries) || entries.length > 32) return fail();
  const allowed = Object.freeze(entries.map(entry));
  if (new Set(allowed.map((value) => value.artifact_manifest_digest)).size !== allowed.length) return fail();
  const authorize = (request: TargetLocalBundlePrepareRequest): AuthorizedContainerBundlePlan => {
    const matches = allowed.filter((value) => value.artifact_manifest_digest === request.artifact_digest
      && value.archive_digest === request.archive_digest && value.build_policy_digest === request.build_policy_digest
      && value.bundle_digest === request.bundle_digest && value.entrypoint === request.entrypoint
      && value.launcher_digest === request.launcher_digest && value.network_alias === request.network_alias
      && value.platform_digest === request.platform_digest && same(value.platform, request.platform));
    if (matches.length !== 1) return fail();
    const authoritative = deriveTargetLocalContainerBundlePolicy({
      archiveDigest: request.archive_digest,
      artifactDigest: request.artifact_digest,
      baseImageConfigDigest: matches[0]!.base_image_config_digest,
      bundleDigest: request.bundle_digest,
      entrypoint: request.entrypoint,
      launcherDigest: request.launcher_digest,
      networkAlias: request.network_alias,
      platform: request.platform
    });
    if (authoritative.buildPolicyDigest !== request.build_policy_digest
      || authoritative.platformDigest !== request.platform_digest) return fail();
    return Object.freeze({ ...matches[0]!, artifact_digest: request.artifact_digest });
  };
  return Object.freeze({ authorize });
};
