import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { SpawnfileError } from "../shared/index.js";

import { type Manifest, manifestSchema } from "./schemas.js";

const describeManifest = (parsed: unknown, manifestPath: string): string => {
  const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  const kind = typeof record.kind === "string" ? record.kind : "manifest";
  return typeof record.name === "string" && record.name.length > 0
    ? `${kind} ${record.name} (${manifestPath})`
    : manifestPath;
};

/**
 * Parses one Spawnfile. Errors name the file, and the declared kind and name
 * when the YAML got far enough to have them, so a member's malformed manifest
 * is attributable from `spawnfile validate` on the organization root.
 */
export const parseManifest = (source: string, manifestPath: string): Manifest => {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    // A YAML syntax error is a malformed manifest, not a runtime failure — wrap
    // it so it exits as a usage error instead of leaking the parser's wording.
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError("invalid_manifest", `Invalid Spawnfile manifest ${manifestPath}: ${reason}`);
  }

  try {
    return manifestSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]!;
      const location = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      throw new SpawnfileError(
        "invalid_manifest",
        `Invalid Spawnfile manifest for ${describeManifest(parsed, manifestPath)}${location}: ${issue.message}`
      );
    }

    throw error;
  }
};
