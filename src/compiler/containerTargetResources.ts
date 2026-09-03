import path from "node:path";
import { createHash } from "node:crypto";

import type {
  ContainerTarget,
  ContainerTargetInput,
  RuntimeContainerMeta
} from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";
import { createExclusiveReattachVolumeName } from "../shared/index.js";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  mergeWorkspaceResourcePlans,
  type WorkspaceResourcePlan
} from "./workspaceResources.js";

const CONFIG_FILE_PLACEHOLDER = "<config-file>";
const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";
const SOURCE_AGENT_PLACEHOLDER = "<agent-name>";
const SOURCE_SLUG_PLACEHOLDER = "<source-slug>";

export interface ResolvedTargetResourcePlan extends WorkspaceResourcePlan {
  canonicalBackingPath: string;
  ownerId: string;
  persistentMountId?: string;
  replacementSentinel?: string;
  resolvedIdentity: string;
  volumeName?: string;
}

export interface WorkspaceResourcePersistentMount {
  /** The author's `name`, when declared on the resource. */
  declared_volume_name?: string;
  id: string;
  lifecycle: "exclusive-reattach";
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
    // Two DIFFERENT declared resources landing on one backing path is always a
    // mistake: the path segment derives from an explicit `name` when one is
    // given, so `id: a`/`id: b` both declaring `name: X` in one scope used to
    // collapse into a single directory and volume, silently, with both
    // workspace symlinks pointing at it. The same id across runtime plans is
    // the legitimate `sharing: team` case and still merges.
    if (existing && existing.id !== resource.id) {
      throw new SpawnfileError("validation_error", `Workspace resources ${existing.id} and ${resource.id} resolve to the same backing volume ${resource.canonicalBackingPath}; a declared volume name must be unique within its scope`);
    }
    if (existing && (existing.mode !== resource.mode || existing.sharing !== resource.sharing || existing.volumeName !== resource.volumeName || (resource.sharing === "per_agent" && existing.ownerId !== resource.ownerId))) {
      throw new SpawnfileError("validation_error", `Workspace volume ${resource.canonicalBackingPath} has incompatible mode, sharing, or owner declarations`);
    }
    const conflictingPath = backingPathByVolumeName.get(resource.volumeName!);
    if (conflictingPath && conflictingPath !== resource.canonicalBackingPath) throw new SpawnfileError("validation_error", "Workspace volume name collision");
    byBackingPath.set(resource.canonicalBackingPath, resource);
    backingPathByVolumeName.set(resource.volumeName!, resource.canonicalBackingPath);
  }
  // Workspace `kind: volume` resources are durable product state: an author
  // declares one precisely so it outlives the container. They are therefore
  // `exclusive-reattach` — deployment-stable name, reattached rather than
  // recreated, one live holder at a time.
  return { resources, mounts: [...byBackingPath.values()].map((resource) => ({
    ...(resource.name?.trim() ? { declared_volume_name: resource.name.trim() } : {}),
    id: resource.persistentMountId!, lifecycle: "exclusive-reattach" as const,
    mount_path: resource.canonicalBackingPath,
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
    if (existingVolume && existingVolume.id !== resource.id) {
      throw new SpawnfileError(
        "validation_error",
        `Container target ${target.id} declares workspace resources ${existingVolume.id} and ${resource.id} that resolve to the same backing volume ${resource.canonicalBackingPath}; a declared volume name must be unique within its scope`
      );
    }
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
  deploymentLineage = "compile"
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
        // Author-declared `name` verbatim (an operator can pre-create or
        // migrate the host volume under exactly that name); otherwise a
        // deployment-stable derived name. Never run-scoped: a fresh
        // NOOPOLIS_RUN_ID must not strand the previous run's state.
        volumeName: resource.name?.trim()
          || createExclusiveReattachVolumeName(
            `${planRoot}\0${deploymentLineage}`,
            `workspace-resource-${pathDigest.slice(0, 24)}`
          )
      };
    });
  });

  return dedupeAndAssertResourcePlans(target, resources);
};
