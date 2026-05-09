import path from "node:path";

import type {
  ContainerTarget,
  ContainerTargetInput,
  RuntimeContainerMeta
} from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  mergeWorkspaceResourcePlans,
  type WorkspaceResourcePlan
} from "./workspaceResources.js";

const CONFIG_FILE_PLACEHOLDER = "<config-file>";
const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";
const SOURCE_AGENT_PLACEHOLDER = "<agent-name>";

const replaceSourceWorkspacePathTemplate = (
  template: string,
  input: ContainerTargetInput,
  instancePaths: RuntimeTargetPlan["instancePaths"],
  meta: RuntimeContainerMeta
): string => {
  const agentName = input.value.kind === "agent" ? input.value.name : input.slug;
  const instanceRoot = instancePaths.instanceRoot ?? path.posix.dirname(instancePaths.workspacePath);

  return template
    .replaceAll(INSTANCE_ROOT_PLACEHOLDER, instanceRoot)
    .replaceAll(CONFIG_FILE_PLACEHOLDER, meta.configFileName)
    .replaceAll(SOURCE_AGENT_PLACEHOLDER, agentName);
};

const resolveSourceWorkspacePath = (
  input: ContainerTargetInput,
  instancePaths: RuntimeTargetPlan["instancePaths"],
  meta: RuntimeContainerMeta
): string =>
  meta.instancePaths.sourceWorkspacePathTemplate
    ? replaceSourceWorkspacePathTemplate(
        meta.instancePaths.sourceWorkspacePathTemplate,
        input,
        instancePaths,
        meta
      )
    : instancePaths.workspacePath;

const sourceTargetId = (
  target: ContainerTarget,
  input: ContainerTargetInput,
  isMergedTarget: boolean
): string => isMergedTarget ? `${target.id}:${input.id}` : target.id;

const pathsOverlap = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

const dedupeAndAssertResourcePlans = (
  target: ContainerTarget,
  resources: WorkspaceResourcePlan[]
): WorkspaceResourcePlan[] => {
  const byLinkPath = new Map<string, WorkspaceResourcePlan>();

  for (const resource of resources) {
    const existing = byLinkPath.get(resource.linkPath);
    if (existing) {
      if (existing.backingPath !== resource.backingPath || existing.id !== resource.id) {
        throw new SpawnfileError(
          "validation_error",
          `Container target ${target.id} declares conflicting workspace resources at ${resource.linkPath}`
        );
      }
      continue;
    }

    const overlapping = [...byLinkPath.values()].find((candidate) =>
      pathsOverlap(candidate.linkPath, resource.linkPath)
    );
    if (overlapping) {
      throw new SpawnfileError(
        "validation_error",
        `Container target ${target.id} declares overlapping workspace resource links ${overlapping.linkPath} and ${resource.linkPath}`
      );
    }

    byLinkPath.set(resource.linkPath, resource);
  }

  return [...byLinkPath.values()].sort(
    (left, right) => left.linkPath.localeCompare(right.linkPath) || left.id.localeCompare(right.id)
  );
};

export const resolveTargetResources = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[],
  instancePaths: RuntimeTargetPlan["instancePaths"],
  meta: RuntimeContainerMeta
): WorkspaceResourcePlan[] => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) {
    return [];
  }

  const isMergedTarget = sourceIds.size > 1;
  const resources = inputs.flatMap((input) => {
    if (!sourceIds.has(input.id) || input.value.kind !== "agent") {
      return [];
    }

    return mergeWorkspaceResourcePlans(
      input.value.workspaceResources ?? [],
      `${target.id}/${input.id}`,
      {
        targetId: sourceTargetId(target, input, isMergedTarget),
        workspacePath: resolveSourceWorkspacePath(input, instancePaths, meta)
      }
    );
  });

  return dedupeAndAssertResourcePlans(target, resources);
};
