import path from "node:path";
import { createHash } from "node:crypto";

import type {
  ContainerTarget,
  ContainerTargetInput,
  RuntimeContainerMeta
} from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";
import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  mergeWorkspaceResourcePlans,
  type WorkspaceResourcePlan
} from "./workspaceResources.js";

const CONFIG_FILE_PLACEHOLDER = "<config-file>";
const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";
const SOURCE_AGENT_PLACEHOLDER = "<agent-name>";
const SOURCE_SLUG_PLACEHOLDER = "<source-slug>";
const RESOURCE_VOLUME_PREFIX = "spawnfile-workspace-resource";

export interface ResolvedTargetResourcePlan extends WorkspaceResourcePlan {
  canonicalBackingPath: string;
  ownerId: string;
  persistentMountId?: string;
  replacementSentinel?: string;
  resolvedIdentity: string;
  volumeName?: string;
}

export interface WorkspaceResourcePersistentMount {
  id: string;
  mount_path: string;
  reason: string;
  volume_name: string;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export const resolveWorkspaceResourceVolumes = (
  runtimePlans: readonly RuntimeTargetPlan[]
): { resources: ResolvedTargetResourcePlan[]; mounts: WorkspaceResourcePersistentMount[] } => {
  const resources = runtimePlans.flatMap((runtimePlan) => (runtimePlan.resources ?? []) as ResolvedTargetResourcePlan[]);
  const byBackingPath = new Map<string, ResolvedTargetResourcePlan>();
  const backingPathByVolumeName = new Map<string, string>();
  for (const resource of resources.filter((candidate) => candidate.kind === "volume")) {
    const existing = byBackingPath.get(resource.canonicalBackingPath);
    if (existing && (existing.mode !== resource.mode || existing.sharing !== resource.sharing || existing.volumeName !== resource.volumeName || (resource.sharing === "per_agent" && existing.ownerId !== resource.ownerId))) {
      throw new SpawnfileError("validation_error", `Workspace volume ${resource.canonicalBackingPath} has incompatible mode, sharing, or owner declarations`);
    }
    const conflictingPath = backingPathByVolumeName.get(resource.volumeName!);
    if (conflictingPath && conflictingPath !== resource.canonicalBackingPath) throw new SpawnfileError("validation_error", "Workspace volume name collision");
    byBackingPath.set(resource.canonicalBackingPath, resource);
    backingPathByVolumeName.set(resource.volumeName!, resource.canonicalBackingPath);
  }
  return { resources, mounts: [...byBackingPath.values()].map((resource) => ({
    id: resource.persistentMountId!, mount_path: resource.canonicalBackingPath,
    reason: `Workspace ${resource.sharing} resource ${resource.id}`, volume_name: resource.volumeName!
  })) };
};

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
    .replaceAll(SOURCE_AGENT_PLACEHOLDER, agentName)
    .replaceAll(SOURCE_SLUG_PLACEHOLDER, input.slug);
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
  resources: ResolvedTargetResourcePlan[]
): ResolvedTargetResourcePlan[] => {
  const byLinkPath = new Map<string, ResolvedTargetResourcePlan>();
  const volumesByBackingPath = new Map<string, ResolvedTargetResourcePlan>();
  const backingPathByVolumeName = new Map<string, string>();

  for (const resource of resources) {
    const existing = byLinkPath.get(resource.linkPath);
    if (existing) {
      if (existing.resolvedIdentity !== resource.resolvedIdentity) {
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
    if (resource.kind !== "volume") continue;
    const existingVolume = volumesByBackingPath.get(resource.canonicalBackingPath);
    if (existingVolume) {
      const incompatible = existingVolume.mode !== resource.mode ||
        existingVolume.sharing !== resource.sharing ||
        existingVolume.volumeName !== resource.volumeName ||
        (resource.sharing === "per_agent" && existingVolume.ownerId !== resource.ownerId);
      if (incompatible) {
        throw new SpawnfileError(
          "validation_error",
          `Container target ${target.id} declares incompatible workspace volume owners or modes at ${resource.canonicalBackingPath}`
        );
      }
    } else {
      volumesByBackingPath.set(resource.canonicalBackingPath, resource);
    }
    const conflictingBackingPath = backingPathByVolumeName.get(resource.volumeName!);
    if (conflictingBackingPath && conflictingBackingPath !== resource.canonicalBackingPath) {
      throw new SpawnfileError("validation_error", `Container target ${target.id} workspace volume identity collision`);
    }
    backingPathByVolumeName.set(resource.volumeName!, resource.canonicalBackingPath);
  }

  return [...byLinkPath.values()].sort(
    (left, right) => left.linkPath.localeCompare(right.linkPath) || left.id.localeCompare(right.id)
  );
};

export const resolveTargetResources = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[],
  instancePaths: RuntimeTargetPlan["instancePaths"],
  meta: RuntimeContainerMeta,
  planRoot: string,
  runId?: string
): ResolvedTargetResourcePlan[] => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) {
    return [];
  }

  const isMergedTarget = sourceIds.size > 1;
  const resources = inputs.flatMap((input): ResolvedTargetResourcePlan[] => {
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
    ).map((resource) => {
      const canonicalBackingPath = path.posix.normalize(resource.backingPath);
      const ownerId = resource.sharing === "per_agent" ? input.id : canonicalBackingPath;
      const resolvedIdentity = `sha256:${digest(JSON.stringify({
        backingPath: canonicalBackingPath,
        kind: resource.kind,
        mode: resource.mode,
        ownerId,
        ...(resource.kind === "bundle" ? { archivePath: resource.archivePath, sha256: resource.sha256 } : {}),
        sharing: resource.sharing
      }))}`;
      if (resource.kind !== "volume") return { ...resource, backingPath: canonicalBackingPath, canonicalBackingPath, ownerId, resolvedIdentity };
      const pathDigest = digest(canonicalBackingPath);
      return {
        ...resource,
        backingPath: canonicalBackingPath,
        canonicalBackingPath,
        ownerId,
        persistentMountId: `workspace-resource-${pathDigest.slice(0, 24)}`,
        replacementSentinel: path.posix.join(canonicalBackingPath, ".spawnfile-resource-identity"),
        resolvedIdentity,
        volumeName: runId ? createPersistentVolumeName(planRoot, `${RESOURCE_VOLUME_PREFIX}-${pathDigest.slice(0, 24)}`, undefined, runId) : `${RESOURCE_VOLUME_PREFIX}-${pathDigest.slice(0, 24)}`
      };
    });
  });

  return dedupeAndAssertResourcePlans(target, resources);
};
