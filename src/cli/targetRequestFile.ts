import { open } from "node:fs/promises";
import path from "node:path";

import {
  parseTargetResourceRequest,
  parseTargetTopologyAttestationRequest,
  type TargetTopologyAttestationRequest,
  type TargetResourceRequest
} from "../target/contracts.js";
import {
  parseComposedPreparationRequest,
  type ComposedPreparationRequest
} from "../target/composedPreparation.js";
import {
  parseTargetPublicArtifactSnapshotRequest,
  type TargetPublicArtifactSnapshotRequest
} from "../target/publicArtifactSnapshot.js";
import {
  parseTargetWorldClockRequest,
  type TargetWorldClockRequest
} from "../target/worldClock.js";
import {
  parseTargetWorldReadinessRequest,
  type TargetWorldReadinessRequest
} from "../target/worldReadiness.js";

export const DEFAULT_TARGET_REQUEST_FILE_BYTES = 262_144;
export const MAX_TARGET_REQUEST_FILE_BYTES = 1_048_576;
export const MAX_TARGET_REQUEST_FILE_PATH_BYTES = 4_096;

const parseByteLimit = (raw: unknown): number => {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1
    || (raw as number) > MAX_TARGET_REQUEST_FILE_BYTES) {
    throw new TypeError("Target request-file byte limit is invalid");
  }
  return raw as number;
};

const requireExactAbsolutePath = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length < 1 || raw.includes("\0")
    || Buffer.byteLength(raw, "utf8") > MAX_TARGET_REQUEST_FILE_PATH_BYTES
    || !path.isAbsolute(raw) || path.normalize(raw) !== raw) {
    throw new TypeError("Target request file path is invalid");
  }
  return raw;
};

const requireObject = (raw: unknown): Record<string, unknown> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Target request file must contain one JSON object");
  }
  return raw as Record<string, unknown>;
};

const readTargetRequestFileValue = async (
  filePath: string,
  byteLimit: number
): Promise<Record<string, unknown>> => {
  const limit = parseByteLimit(byteLimit);
  const exactPath = requireExactAbsolutePath(filePath);
  const handle = await open(exactPath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) {
      throw new TypeError("Target request file is not a bounded regular file");
    }

    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const result = await handle.read(bytes, offset, limit + 1 - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > limit) {
      throw new TypeError("Target request file exceeds the byte limit");
    }

    return requireObject(JSON.parse(bytes.toString("utf8", 0, offset)) as unknown);
  } finally {
    await handle.close();
  }
};

export const readTargetRequestFile = async (
  filePath: string,
  byteLimit: number = DEFAULT_TARGET_REQUEST_FILE_BYTES
): Promise<TargetResourceRequest> =>
  parseTargetResourceRequest(await readTargetRequestFileValue(filePath, byteLimit));

export const readComposedPreparationRequestFile = async (
  filePath: string,
  byteLimit: number = DEFAULT_TARGET_REQUEST_FILE_BYTES
): Promise<ComposedPreparationRequest> =>
  parseComposedPreparationRequest(await readTargetRequestFileValue(filePath, byteLimit));

export const readTargetTopologyAttestationRequestFile = async (
  filePath: string,
  byteLimit: number = DEFAULT_TARGET_REQUEST_FILE_BYTES
): Promise<TargetTopologyAttestationRequest> =>
  parseTargetTopologyAttestationRequest(await readTargetRequestFileValue(filePath, byteLimit));

export const readTargetPublicArtifactSnapshotRequestFile = async (
  filePath: string,
  byteLimit: number = DEFAULT_TARGET_REQUEST_FILE_BYTES
): Promise<TargetPublicArtifactSnapshotRequest> =>
  parseTargetPublicArtifactSnapshotRequest(
    await readTargetRequestFileValue(filePath, byteLimit)
  );

export const readTargetWorldReadinessRequestFile = async (
  filePath: string,
  byteLimit: number = DEFAULT_TARGET_REQUEST_FILE_BYTES
): Promise<TargetWorldReadinessRequest> =>
  parseTargetWorldReadinessRequest(await readTargetRequestFileValue(filePath, byteLimit));

export const readTargetWorldClockRequestFile = async (
  filePath: string,
  byteLimit: number = DEFAULT_TARGET_REQUEST_FILE_BYTES
): Promise<TargetWorldClockRequest> =>
  parseTargetWorldClockRequest(await readTargetRequestFileValue(filePath, byteLimit));
