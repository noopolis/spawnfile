import { existsSync } from "node:fs";
import path from "node:path";

import { parseImplicitImageReference } from "../distribution/index.js";

export type CommandInput =
  | { kind: "project"; path: string }
  | { kind: "image"; ref: string }
  | { kind: "invalid"; value: string };

export interface ResolveCommandInputOptions {
  forceImage?: boolean;
}

/**
 * Resolves a positional argument that may be a project path or an image
 * reference. An existing directory or file always wins unless --image forces
 * image mode. Implicit image refs require a tag, digest, or registry component.
 */
export const resolveCommandInput = (
  value: string,
  options: ResolveCommandInputOptions = {}
): CommandInput => {
  if (!options.forceImage) {
    const resolved = path.resolve(value);
    if (existsSync(resolved)) {
      return { kind: "project", path: value };
    }
  }

  if (options.forceImage) {
    // --image accepts Docker's full reference grammar, including bare names.
    return { kind: "image", ref: value };
  }

  const parsed = parseImplicitImageReference(value);
  if (parsed) {
    return { kind: "image", ref: value };
  }

  return { kind: "invalid", value };
};
