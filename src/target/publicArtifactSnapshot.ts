import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { z } from "zod";

import {
  assertOrdinaryJsonGraph,
  opaqueTargetHandleSchema,
  runIdSchema,
  selectedTargetSchema
} from "./contracts.js";

export const TARGET_PUBLIC_ARTIFACT_SNAPSHOT_REQUEST_VERSION =
  "spawnfile.target-public-artifact-snapshot.request.v1" as const;
export const TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION =
  "spawnfile.target-public-artifact-snapshot.v1" as const;
export const TARGET_PUBLIC_ARTIFACT_ROOT = "/tmp/spawnfile-public" as const;
export const MAX_TARGET_PUBLIC_ARTIFACT_BYTES = 131_072;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const identifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const mediaTypeSchema = z.string()
  .max(127)
  .regex(/^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);
const publicPathSchema = z.string().max(255)
  .regex(/^\/tmp\/spawnfile-public\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine((value) => !value.includes("//") && !value.endsWith("/")
    && !value.split("/").some((part) => part === "." || part === ".."));

export const targetPublicArtifactSnapshotRequestSchema = z.object({
  artifact: z.object({
    id: identifierSchema,
    max_bytes: z.number().int().min(1).max(MAX_TARGET_PUBLIC_ARTIFACT_BYTES),
    media_type: mediaTypeSchema,
    path: publicPathSchema
  }).strict(),
  descriptor_digest: digestSchema,
  run_id: runIdSchema,
  selected_target: selectedTargetSchema,
  version: z.literal(TARGET_PUBLIC_ARTIFACT_SNAPSHOT_REQUEST_VERSION),
  world_service_handle: opaqueTargetHandleSchema
}).strict();

export const targetPublicArtifactSnapshotSchema = z.object({
  artifact_id: identifierSchema,
  content_base64: z.string().max(Math.ceil(MAX_TARGET_PUBLIC_ARTIFACT_BYTES / 3) * 4),
  content_digest: digestSchema,
  media_type: mediaTypeSchema,
  request_digest: digestSchema,
  run_id: runIdSchema,
  size_bytes: z.number().int().min(0).max(MAX_TARGET_PUBLIC_ARTIFACT_BYTES),
  version: z.literal(TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION)
}).strict().superRefine((value, context) => {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value.content_base64, "base64");
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid base64 content" });
    return;
  }
  if (bytes.toString("base64") !== value.content_base64
    || bytes.byteLength !== value.size_bytes
    || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== value.content_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact content mismatch" });
  }
});

export type TargetPublicArtifactSnapshotRequest =
  z.infer<typeof targetPublicArtifactSnapshotRequestSchema>;
export type TargetPublicArtifactSnapshot =
  z.infer<typeof targetPublicArtifactSnapshotSchema>;

const canonicalJsonValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const canonicalJson = (value: unknown): string => {
  assertOrdinaryJsonGraph(value);
  return canonicalJsonValue(value);
};

/*
 * Public artifact snapshots are deliberately one flat envelope.  Their base64
 * payload can be larger than the generic JSON graph's aggregate 64 KiB string
 * allowance, so admit that one field without relaxing the shared graph guard.
 * Descriptor inspection happens before Zod is allowed to read any property.
 */
const assertOrdinaryPublicArtifactSnapshot = (raw: unknown): void => {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || nodeTypes.isProxy(raw)) throw new Error();
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(raw);
    if (keys.length > 8) throw new Error();
    let ordinaryStringBytes = 0;
    for (const key of keys) {
      if (typeof key !== "string") throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error();
      }
      ordinaryStringBytes += Buffer.byteLength(key, "utf8");
      const value = descriptor.value;
      if (typeof value === "string") {
        if (key === "content_base64") {
          if (Buffer.byteLength(value, "utf8")
            > Math.ceil(MAX_TARGET_PUBLIC_ARTIFACT_BYTES / 3) * 4) throw new Error();
        } else {
          ordinaryStringBytes += Buffer.byteLength(value, "utf8");
        }
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error();
      } else if (value !== null && typeof value !== "boolean") {
        throw new Error();
      }
    }
    if (ordinaryStringBytes > 65_536) throw new Error();
  } catch {
    throw new TypeError("invalid JSON-like graph");
  }
};

export const parseTargetPublicArtifactSnapshotRequest = (
  raw: unknown
): TargetPublicArtifactSnapshotRequest => {
  assertOrdinaryJsonGraph(raw);
  return targetPublicArtifactSnapshotRequestSchema.parse(raw);
};

export const parseTargetPublicArtifactSnapshot = (
  raw: unknown
): TargetPublicArtifactSnapshot => {
  assertOrdinaryPublicArtifactSnapshot(raw);
  return targetPublicArtifactSnapshotSchema.parse(raw);
};

export const createTargetPublicArtifactSnapshotRequestDigest = (
  raw: unknown
): `sha256:${string}` => `sha256:${createHash("sha256")
  .update("spawnfile.target-public-artifact-snapshot.request.v1\0", "utf8")
  .update(canonicalJson(parseTargetPublicArtifactSnapshotRequest(raw)), "utf8")
  .digest("hex")}`;

export const createTargetPublicArtifactSnapshot = (input: {
  readonly content: Uint8Array;
  readonly request: TargetPublicArtifactSnapshotRequest;
}): TargetPublicArtifactSnapshot => {
  const request = parseTargetPublicArtifactSnapshotRequest(input.request);
  const bytes = Buffer.from(input.content);
  if (bytes.byteLength > request.artifact.max_bytes) {
    throw new TypeError("Public artifact exceeds its declared bound");
  }
  return parseTargetPublicArtifactSnapshot({
    artifact_id: request.artifact.id,
    content_base64: bytes.toString("base64"),
    content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    media_type: request.artifact.media_type,
    request_digest: createTargetPublicArtifactSnapshotRequestDigest(request),
    run_id: request.run_id,
    size_bytes: bytes.byteLength,
    version: TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION
  });
};

export const createCanonicalTargetPublicArtifactSnapshotBytes = (
  raw: unknown
): string => canonicalJsonValue(parseTargetPublicArtifactSnapshot(raw));
