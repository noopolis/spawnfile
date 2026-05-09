import path from "node:path";

import type { TeamWorkspaceResource } from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

import { createShortHash, slugify } from "./helpers.js";

export type WorkspaceResourceSharing = "per_agent" | "team";

export interface WorkspaceResourceScope {
  kind: "agent" | "team";
  key: string;
  name: string;
}

export type ResolvedWorkspaceResource = TeamWorkspaceResource & {
  scope: WorkspaceResourceScope;
  sharing: WorkspaceResourceSharing;
};

export interface WorkspaceResourcePlan {
  backingPath: string;
  branch?: string;
  id: string;
  kind: "git" | "volume";
  linkPath: string;
  mode: "mutable" | "readonly";
  mount: string;
  name?: string;
  ref?: string;
  sharing: WorkspaceResourceSharing;
  tag?: string;
  url?: string;
}

const normalizeMount = (value: string): string => {
  const trimmed = value.trim();
  const workspaceRelative = trimmed.startsWith("${workspace}/")
    ? `./${trimmed.slice("${workspace}/".length)}`
    : trimmed;
  const collapsed = workspaceRelative.replace(/\/+/g, "/");
  if (collapsed.startsWith("./")) {
    const relativePath = collapsed.slice(2).replace(/\/+$/u, "");
    return `./${relativePath}`;
  }
  return collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : "/";
};

const normalizeResourceIdentity = (resource: ResolvedWorkspaceResource): string => {
  if (resource.kind === "git") {
    return JSON.stringify({
      branch: resource.branch?.trim() ?? "",
      kind: "git",
      mode: resource.mode,
      mount: normalizeMount(resource.mount),
      ref: resource.ref?.trim() ?? "",
      sharing: resource.sharing,
      tag: resource.tag?.trim() ?? "",
      url: resource.url.trim()
    });
  }

  return JSON.stringify({
    kind: "volume",
    mode: resource.mode,
    mount: normalizeMount(resource.mount),
    name: resource.name?.trim() ?? "",
    scope: resource.sharing === "team" ? resource.scope.key : "",
    sharing: resource.sharing
  });
};

const mountsOverlap = (left: string, right: string): boolean =>
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

const resolveSharing = (resource: TeamWorkspaceResource): WorkspaceResourceSharing =>
  resource.sharing ?? "per_agent";

const toResolvedResource = (
  resource: TeamWorkspaceResource,
  scope: WorkspaceResourceScope
): ResolvedWorkspaceResource => ({
  ...resource,
  mount: normalizeMount(resource.mount),
  scope,
  sharing: resolveSharing(resource)
});

const createPathSegment = (value: string): string => {
  const slug = slugify(value);
  const hash = createShortHash(value);
  return slug ? `${slug}-${hash}` : hash;
};

const createScopeSegment = (scope: WorkspaceResourceScope): string =>
  `${scope.kind}-${createPathSegment(`${scope.name}:${scope.key}`)}`;

const createResourceSegment = (resource: ResolvedWorkspaceResource): string =>
  createPathSegment(resource.kind === "volume" && resource.name ? resource.name : resource.id);

const resolveLinkPath = (mount: string, workspacePath: string): string =>
  mount.startsWith("./")
    ? path.posix.join(workspacePath, mount.slice(2))
    : mount;

const resolveBackingPath = (
  resource: ResolvedWorkspaceResource,
  targetId: string
): string => {
  const resourceSegment = createResourceSegment(resource);
  if (resource.sharing === "team") {
    return path.posix.join(
      "/var/lib/spawnfile/resources/teams",
      createScopeSegment(resource.scope),
      resourceSegment
    );
  }

  return path.posix.join(
    "/var/lib/spawnfile/resources/instances",
    createPathSegment(targetId),
    resourceSegment
  );
};

export const mergeWorkspaceResources = (
  inherited: ResolvedWorkspaceResource[] = [],
  local: TeamWorkspaceResource[] = [],
  ownerName: string,
  ownerScope: WorkspaceResourceScope
): ResolvedWorkspaceResource[] => {
  const merged: ResolvedWorkspaceResource[] = [];
  const identityById = new Map<string, string>();
  const resources = [
    ...inherited,
    ...local.map((resource) => toResolvedResource(resource, ownerScope))
  ];

  for (const resource of resources) {
    const mount = normalizeMount(resource.mount);
    const identity = normalizeResourceIdentity(resource);
    const existingIdentity = identityById.get(resource.id);

    if (existingIdentity) {
      if (existingIdentity !== identity) {
        throw new SpawnfileError(
          "validation_error",
          `Workspace resource ${resource.id} resolves differently for ${ownerName}`
        );
      }
      continue;
    }

    const overlapping = merged.find((candidate) =>
      candidate.id !== resource.id &&
      mountsOverlap(normalizeMount(candidate.mount), mount)
    );
    if (overlapping) {
      throw new SpawnfileError(
        "validation_error",
        `Workspace resources ${overlapping.id} and ${resource.id} use overlapping mounts for ${ownerName}`
      );
    }

    identityById.set(resource.id, identity);
    merged.push({ ...resource, mount });
  }

  return merged.sort((left, right) => left.id.localeCompare(right.id));
};

export const toWorkspaceResourcePlan = (
  resource: ResolvedWorkspaceResource,
  context: { targetId: string; workspacePath: string }
): WorkspaceResourcePlan =>
  resource.kind === "git"
    ? {
        backingPath: resolveBackingPath(resource, context.targetId),
        ...(resource.branch ? { branch: resource.branch } : {}),
        id: resource.id,
        kind: "git",
        linkPath: resolveLinkPath(normalizeMount(resource.mount), context.workspacePath),
        mode: resource.mode,
        mount: normalizeMount(resource.mount),
        ...(resource.ref ? { ref: resource.ref } : {}),
        sharing: resource.sharing,
        ...(resource.tag ? { tag: resource.tag } : {}),
        url: resource.url
      }
    : {
        backingPath: resolveBackingPath(resource, context.targetId),
        id: resource.id,
        kind: "volume",
        linkPath: resolveLinkPath(normalizeMount(resource.mount), context.workspacePath),
        mode: resource.mode,
        mount: normalizeMount(resource.mount),
        ...(resource.name ? { name: resource.name } : {}),
        sharing: resource.sharing
      };

export const mergeWorkspaceResourcePlans = (
  resources: ResolvedWorkspaceResource[],
  ownerName: string,
  context: { targetId: string; workspacePath: string }
): WorkspaceResourcePlan[] =>
  mergeWorkspaceResources(resources, [], ownerName, {
    kind: "agent",
    key: context.targetId,
    name: context.targetId
  }).map((resource) => toWorkspaceResourcePlan(resource, context));
