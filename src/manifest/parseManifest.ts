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

type Issue = { code?: string; errors?: Issue[][]; message: string; path: PropertyKey[] };

/**
 * A union failure (a team member that is neither `{id, ref}` nor a valid inline
 * agent) reports the branch that matched furthest, when exactly one did, so an
 * inline agent's real defect surfaces instead of the generic union message.
 * Nested unions resolve first, so depth compares the most specific issues.
 */
const specificIssue = (issue: Issue): Issue => {
  if (issue.code !== "invalid_union" || !issue.errors?.length) return issue;
  const candidates = issue.errors.map((branch) => branch
    .map(specificIssue)
    .reduce<Issue | undefined>((deepest, candidate) =>
      deepest === undefined || candidate.path.length > deepest.path.length ? candidate : deepest, undefined));
  const depths = candidates.map((candidate) => candidate?.path.length ?? -1);
  const best = Math.max(...depths);
  if (best <= 0 || depths.filter((depth) => depth === best).length !== 1) return issue;
  const nested = candidates[depths.indexOf(best)]!;
  return { ...nested, path: [...issue.path, ...nested.path] };
};

const describeMember = (parsed: unknown, path: PropertyKey[]): string => {
  if (path[0] !== "members" || typeof path[1] !== "number") return "";
  const members = (parsed as { members?: unknown }).members;
  const member = Array.isArray(members) ? members[path[1]] as { id?: unknown } | undefined : undefined;
  return typeof member?.id === "string" ? ` member ${member.id}` : "";
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
      const issue = specificIssue(error.issues[0] as Issue);
      const location = issue.path.length > 0 ? ` at ${issue.path.map(String).join(".")}` : "";
      throw new SpawnfileError(
        "invalid_manifest",
        `Invalid Spawnfile manifest for ${describeManifest(parsed, manifestPath)}${describeMember(parsed, issue.path)}${location}: ${issue.message}`
      );
    }

    throw error;
  }
};
