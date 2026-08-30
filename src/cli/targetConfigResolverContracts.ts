import { createHash } from "node:crypto";

import type {
  PreparedEvidenceHelperReceipt,
  PrepareEvidenceHelperInput,
} from "../evidenceExportHelper/index.js";
import type { DockerTargetExecFile } from "../target/dockerTarget.js";

import type { PreparedArtifactMapping } from "./targetDefaultConfig.js";
import { TARGET_DEFAULT_CONFIG_STDIN_VERSION } from "./targetDefaultConfigStdin.js";
import { TARGET_CONFIG_PREPARED_PLAN_VERSION } from "./targetConfigPreparedPlan.js";

export const TARGET_CONFIG_RESOLUTION_VERSION =
  "spawnfile.target-config-resolution.v1" as const;
export const TARGET_CONFIG_DIGEST_VERSION =
  "spawnfile.target-config-digest.v1" as const;
/** Exact version for the strict `resolve_config --prepared-plan` document. */
export const TARGET_CONFIG_PREPARED_PLAN_ABI_VERSION = TARGET_CONFIG_PREPARED_PLAN_VERSION;
export const STANDARD_WORLD_BASE_IMAGE = "node:22-bookworm-slim";

export interface ResolveTargetConfigInput {
  readonly allowRemotePull?: boolean;
  readonly baseImage?: string;
  readonly context?: string;
  readonly dockerCommand?: string;
  readonly evidenceDestination: string;
  readonly prepareEvidenceHelper?: boolean;
  readonly execFile?: DockerTargetExecFile;
  readonly preparedPlanPath?: string;
  readonly pull?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface TargetConfigResolution {
  readonly base_image: {
    readonly config_digest: `sha256:${string}`;
    readonly reference: string;
  };
  readonly endpoint: {
    readonly class: "local" | "remote";
    readonly transport: "fd" | "http" | "https" | "npipe" | "ssh" | "tcp" | "unix";
  };
  readonly context_selection: "auto-local" | "explicit";
  readonly platform: {
    readonly architecture: "amd64" | "arm64";
    readonly os: "linux";
  };
  readonly prepared_evidence_helper?: PreparedEvidenceHelperReceipt;
  readonly target_config: {
    readonly context: string;
    readonly dockerCommand: string;
    readonly evidenceDestination: string;
    readonly evidenceHelperBaseImage?: string;
    readonly preparedEvidenceHelper?: PreparedEvidenceHelperReceipt;
    readonly preparedArtifactMappings?: readonly PreparedArtifactMapping[];
    readonly timeoutMs: number;
    readonly version: typeof TARGET_DEFAULT_CONFIG_STDIN_VERSION;
  };
  readonly target_config_digest: `sha256:${string}`;
  readonly version: typeof TARGET_CONFIG_RESOLUTION_VERSION;
}
export interface ResolveTargetConfigDependencies {
  readonly prepareEvidenceExportHelper?: (
    input: PrepareEvidenceHelperInput,
  ) => Promise<PreparedEvidenceHelperReceipt>;
}

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Target configuration is not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Target configuration is not JSON");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

export const createCanonicalTargetConfigBytes = (
  targetConfig: TargetConfigResolution["target_config"],
): string => canonicalJson(targetConfig);
export const createTargetConfigDigest = (
  targetConfig: TargetConfigResolution["target_config"],
): `sha256:${string}` => `sha256:${createHash("sha256")
  .update(`${TARGET_CONFIG_DIGEST_VERSION}\0`, "utf8")
  .update(createCanonicalTargetConfigBytes(targetConfig), "utf8")
  .digest("hex")}`;
export const createTargetConfigResolutionBytes = (
  resolution: TargetConfigResolution,
): string => JSON.stringify(resolution);
