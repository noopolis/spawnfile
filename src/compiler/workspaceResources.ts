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
  archivePath?: string;
  backingPath: string;
  branch?: string;
  id: string;
  kind: "bundle" | "git" | "volume";
  linkPath: string;
  mode: "mutable" | "readonly";
  mount: string;
  name?: string;
  ref?: string;
  sharing: WorkspaceResourceSharing;
  sha256?: string;
  source?: string;
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
  if (resource.kind === "bundle") {
    // Relative paths compare as resolved against their declaring manifest: the same text in two directories is two inputs.
    const base = path.dirname(resource.scope.key);
    const build = resource.build && { files: { ...resource.build.files, root: path.resolve(base, resource.build.files.root) } };
    return JSON.stringify({ build: build ?? null, kind: resource.kind, mode: resource.mode, mount: normalizeMount(resource.mount), sha256: resource.sha256 ?? null, source: resource.source === undefined ? null : path.resolve(base, resource.source), sharing: resource.sharing });
  }
  if (resource.kind === "git") {
    return JSON.stringify({
      auth: resource.auth ?? null,
      branch: resource.branch?.trim() ?? "",
      exclude: resource.exclude ?? null,
      fetch: resource.fetch ?? "start",
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
    // Feed paths resolve against the declaring manifest, like bundle inputs.
    ...(resource.feed ? { feed: { ...resource.feed, base: path.dirname(resource.scope.key) } } : {}),
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
): ResolvedWorkspaceResource => resource.kind === "bundle"
  ? { ...resource, mount: normalizeMount(resource.mount), scope, sharing: "per_agent" }
  : { ...resource, mount: normalizeMount(resource.mount), scope, sharing: resolveSharing(resource) };

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

/** A bundle's digest exists only after `resolveWorkspaceBundles` built or hashed it. */
const resolvedBundleDigest = (resource: ResolvedWorkspaceResource & { kind: "bundle" }): string => {
  if (resource.sha256 === undefined) throw new SpawnfileError("compile_error", `Workspace bundle ${resource.id} has not been built`);
  return resource.sha256;
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
    : resource.kind === "bundle" ? {
        archivePath: `/opt/spawnfile/workspace-bundles/${resolvedBundleDigest(resource).slice(7)}.tar`,
        backingPath: resolveBackingPath(resource, context.targetId), id: resource.id, kind: "bundle",
        linkPath: resolveLinkPath(normalizeMount(resource.mount), context.workspacePath), mode: resource.mode,
        mount: normalizeMount(resource.mount), sharing: resource.sharing, sha256: resolvedBundleDigest(resource),
        ...(resource.source !== undefined ? { source: path.resolve(path.dirname(resource.scope.key), resource.source) } : {})
      } : {
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
