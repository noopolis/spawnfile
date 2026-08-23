import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

import {
  parseTargetPreparedArtifactMappings,
  type PreparedArtifactMapping,
} from "./targetDefaultConfig.js";

export const TARGET_CONFIG_PREPARED_PLAN_VERSION =
  "spawnfile.target-config-prepared-plan.v1" as const;

const MAX_PATH_BYTES = 4_096;
const MAX_PREPARED_PLAN_BYTES = 128 * 1_024;
const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};
const planPath = (value: unknown): string => {
  if (typeof value !== "string" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || !path.isAbsolute(value) || path.normalize(value) !== value) {
    return fail("Prepared target plan path must be absolute and normalized");
  }
  return value;
};

export const readTargetConfigPreparedPlan = async (
  rawPath: string | undefined,
  evidenceDestination: string,
): Promise<readonly PreparedArtifactMapping[] | undefined> => {
  if (rawPath === undefined) return undefined;
  const resolved = planPath(rawPath);
  const owner = process.getuid?.();
  let handle;
  try {
    const before = await lstat(resolved);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1
      || before.size > MAX_PREPARED_PLAN_BYTES || (before.mode & 0o777) !== 0o600
      || owner !== undefined && before.uid !== owner) {
      return fail("Prepared target plan must be a private bounded regular file");
    }
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytes.byteLength) {
      return fail("Prepared target plan changed while it was read");
    }
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return fail("Prepared target plan must be UTF-8 JSON"); }
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join("\0")
        !== "evidence_destination\0prepared_artifact_mapping\0version") {
      return fail("Prepared target plan has an invalid shape");
    }
    const value = parsed as Record<string, unknown>;
    if (value.version !== TARGET_CONFIG_PREPARED_PLAN_VERSION) {
      return fail("Prepared target plan version is invalid");
    }
    if (value.evidence_destination !== evidenceDestination) {
      return fail("Prepared target plan evidence destination does not match");
    }
    try { return parseTargetPreparedArtifactMappings([value.prepared_artifact_mapping]); }
    catch { return fail("Prepared target plan artifact mapping is invalid"); }
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    return fail("Prepared target plan is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};
