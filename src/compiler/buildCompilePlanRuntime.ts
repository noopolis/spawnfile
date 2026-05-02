import {
  type AgentManifest,
  type ExecutionBlock,
  type SharedSurface,
  normalizeRuntimeBinding
} from "../manifest/index.js";
import { assertRuntimeCanCompile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { ResolvedDocument, ResolvedRuntime } from "./types.js";

export interface AgentVisitContext {
  inheritedExecution?: ExecutionBlock;
  inheritedShared?: {
    manifestPath: string;
    surface: SharedSurface | undefined;
  };
  inheritedRuntime?: ResolvedRuntime;
  isSubagent: boolean;
}

export const resolveRuntime = async (
  manifest: AgentManifest,
  context: AgentVisitContext
): Promise<ResolvedRuntime> => {
  const localRuntime = normalizeRuntimeBinding(manifest.runtime);

  if (context.isSubagent) {
    if (!context.inheritedRuntime) {
      throw new SpawnfileError(
        "runtime_error",
        `Subagent ${manifest.name} is missing inherited runtime context`
      );
    }

    if (
      localRuntime &&
      localRuntime.name !== context.inheritedRuntime.name
    ) {
      throw new SpawnfileError(
        "runtime_error",
        `Subagent ${manifest.name} must match parent runtime`
      );
    }

    return context.inheritedRuntime;
  }

  if (!localRuntime) {
    throw new SpawnfileError(
      "runtime_error",
      `Agent ${manifest.name} does not declare a runtime`
    );
  }

  await assertRuntimeCanCompile(localRuntime.name);

  return localRuntime;
};

export const normalizeDescription = (description: string): string =>
  description.replace(/\s+/g, " ").trim();

const deriveDescriptionFromDocs = (docs: ResolvedDocument[]): string => {
  const identity = docs.find((doc) => doc.role === "identity")?.content;
  if (!identity) {
    return "";
  }

  const paragraph = identity
    .split(/\n\s*\n/)
    .map((block) => normalizeDescription(block))
    .find((block) => block.length > 0 && !/^#{1,6}\s+/.test(block));
  if (!paragraph) {
    return "";
  }

  return paragraph.length > 200 ? paragraph.slice(0, 200).trimEnd() : paragraph;
};

export const resolveDescription = (
  description: string | undefined,
  docs: ResolvedDocument[]
): string =>
  description !== undefined
    ? normalizeDescription(description)
    : deriveDescriptionFromDocs(docs);
