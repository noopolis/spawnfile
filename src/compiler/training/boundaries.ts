import { createHash } from "node:crypto";

import { SpawnfileError } from "../../shared/index.js";
import type { TrainingPlan } from "./plan/index.js";

/** The training CLI's component key for a whole-file editable resource (`training/cli/native.ts`). */
export const editableComponentKey = (path: string): string =>
  `resource-${createHash("sha256").update(path).digest("hex").slice(0, 16)}#file`;

/**
 * Authored optimizer boundaries name an editable target file as the agent declares it (`AGENTS.md`); the
 * optimizer knows components by key. Each boundary's first argument is lowered to that key. A name that is
 * no declared editable file is refused here rather than by the optimizer mid-run.
 */
export const lowerBoundaries = (plan: TrainingPlan, boundaries: readonly string[]): string[] => {
  const files = [...new Set(plan.targets.flatMap(target => target.files.map(file => file.path)))];
  return boundaries.map(boundary => {
    const match = /^([a-z-]+) (\[.*\])$/su.exec(boundary);
    let args: unknown;
    try { args = match ? JSON.parse(match[2]!) : undefined; } catch { args = undefined; }
    if (!match || !Array.isArray(args) || typeof args[0] !== "string") {
      throw new SpawnfileError("validation_error", `Training optimizer boundary is not an operation with a JSON argument list: ${boundary}`);
    }
    const name = args[0];
    const file = files.find(candidate => candidate === name || candidate.endsWith(`/${name}`));
    if (!file) throw new SpawnfileError("validation_error", `Training optimizer boundary names no editable target file: ${name}`);
    return `${match[1]} ${JSON.stringify([editableComponentKey(file), ...args.slice(1)])}`;
  });
};
