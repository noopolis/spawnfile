import { createHash } from "node:crypto";

/**
 * Private policy derivation for a target-local Docker bundle build. This
 * intentionally produces only commitment digests; the base-image config ID
 * remains an operator-side configuration input and is never a public receipt
 * field.
 */
export const TARGET_LOCAL_CONTAINER_BUNDLE_POLICY = Object.freeze({
  builder: Object.freeze({
    dockerfile: "FROM pinned-config; WORKDIR /opt/bundle; COPY bundle; ENTRYPOINT node /opt/bundle/<entrypoint>; CMD []",
    network: "none",
    pull: false,
    version: "spawnfile.target-local-container-bundle.builder.v1"
  }),
  version: "spawnfile.target-local-container-bundle-policy.v1"
});

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u;
const ALIAS = /^[a-z][a-z0-9-]{0,62}$/u;
const fail = (): never => {
  throw new Error("Target-local container bundle policy failed");
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonical(entry[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const digest = (domain: "build-policy" | "platform", value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256")
    .update(`spawnfile.target-local-container-bundle.${domain}.v1\0`, "utf8")
    .update(canonical(value), "utf8").digest("hex")}`;

export interface TargetLocalContainerBundlePolicyInput {
  readonly archiveDigest: string;
  readonly artifactDigest: string;
  readonly baseImageConfigDigest: string;
  readonly bundleDigest: string;
  readonly entrypoint: string;
  readonly launcherDigest: string;
  readonly networkAlias: string;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
}

/** One frozen derivation binds immutable bundle claims to the generic builder. */
export const deriveTargetLocalContainerBundlePolicy = (
  raw: TargetLocalContainerBundlePolicyInput
): Readonly<{ readonly buildPolicyDigest: `sha256:${string}`; readonly platformDigest: `sha256:${string}` }> => {
  if (!raw || typeof raw !== "object"
    || ![raw.archiveDigest, raw.artifactDigest, raw.baseImageConfigDigest, raw.bundleDigest, raw.launcherDigest]
      .every((value) => typeof value === "string" && DIGEST.test(value))
    || typeof raw.entrypoint !== "string" || !ENTRYPOINT.test(raw.entrypoint)
    || raw.entrypoint.includes("//") || raw.entrypoint.split("/").some((part) => part === "." || part === "..")
    || typeof raw.networkAlias !== "string" || !ALIAS.test(raw.networkAlias)
    || !raw.platform || raw.platform.os !== "linux"
    || (raw.platform.architecture !== "amd64" && raw.platform.architecture !== "arm64")) fail();
  const platform = Object.freeze({ architecture: raw.platform.architecture, os: "linux" as const });
  const platformDigest = digest("platform", platform);
  const buildPolicyDigest = digest("build-policy", {
    builder: TARGET_LOCAL_CONTAINER_BUNDLE_POLICY.builder,
    claims: {
      archive_digest: raw.archiveDigest,
      artifact_digest: raw.artifactDigest,
      base_image_config_digest: raw.baseImageConfigDigest,
      bundle_digest: raw.bundleDigest,
      entrypoint: raw.entrypoint,
      launcher_digest: raw.launcherDigest,
      network_alias: raw.networkAlias,
      platform,
      platform_digest: platformDigest
    },
    version: TARGET_LOCAL_CONTAINER_BUNDLE_POLICY.version
  });
  return Object.freeze({ buildPolicyDigest, platformDigest });
};
