import {
  type AgentManifest,
  type ExecutionBlock,
  type SharedSurface,
  normalizeRuntimeBinding
} from "../manifest/index.js";
import { assertRuntimeCanCompile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CompilePlanNode, ResolvedDocument, ResolvedRuntime } from "./types.js";
import type { ResolvedWorkspaceResource } from "./workspaceResources.js";

export interface AgentVisitContext {
  inheritedExecution?: ExecutionBlock;
  inheritedResources?: ResolvedWorkspaceResource[];
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

export const createRuntimeGroups = (
  nodes: CompilePlanNode[]
): Record<string, { nodeIds: string[] }> =>
  nodes.reduce<Record<string, { nodeIds: string[] }>>((groups, node) => {
    if (!node.runtimeName) {
      return groups;
    }

    const group = groups[node.runtimeName] ?? { nodeIds: [] };
    group.nodeIds.push(node.id);
    groups[node.runtimeName] = group;
    return groups;
  }, {});
