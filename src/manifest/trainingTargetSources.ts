import { lstat } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";
import { isInlineAgentMember, type Manifest } from "./schemas.js";
import type { TrainingDeclaration } from "./trainingSchemas.js";

/** Refuse invalid local target sources before ordinary document or skill loading. */
export const validateTrainingTargetSources = async (
  manifestPath: string,
  manifest: Manifest
): Promise<void> => {
  const declarations: Array<{ declaredBy: string; training?: TrainingDeclaration }> = manifest.kind === "agent"
    ? [{ declaredBy: `agent:${manifest.name}`, training: manifest.training }]
    : [
        { declaredBy: `team:${manifest.name}`, training: manifest.shared?.training },
        ...manifest.members.filter(isInlineAgentMember).map((member) => ({
          declaredBy: `agent:${member.id}`, training: member.training
        }))
      ];
  const absoluteManifestPath = path.resolve(manifestPath);
  for (const { declaredBy, training } of declarations) {
    for (const target of training?.targets ?? []) {
      for (const file of target.files) {
        const sourcePath = path.resolve(path.dirname(absoluteManifestPath), file);
        const context = `Training target ${sourcePath} declared by ${declaredBy} (${absoluteManifestPath})`;
        const stats = await lstat(sourcePath).catch((cause: unknown) => {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new SpawnfileError("validation_error", `${context} must be an existing regular .md file: ${reason}`, { cause });
        });
        if (stats.isSymbolicLink()) {
          throw new SpawnfileError("validation_error", `${context} must not be a symlink`);
        }
        if (!stats.isFile()) {
          throw new SpawnfileError("validation_error", `${context} must be an existing regular .md file`);
        }
      }
    }
  }
};
