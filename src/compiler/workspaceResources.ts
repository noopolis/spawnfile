import type { TeamWorkspaceResource } from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

export interface WorkspaceResourcePlan {
  branch?: string;
  id: string;
  kind: "git" | "volume";
  mode: "mutable" | "readonly";
  mount: string;
  name?: string;
  ref?: string;
  tag?: string;
  url?: string;
}

const normalizeMount = (value: string): string => {
  const collapsed = value.trim().replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : "/";
};

const normalizeResourceIdentity = (resource: TeamWorkspaceResource): string => {
  if (resource.kind === "git") {
    return JSON.stringify({
      branch: resource.branch?.trim() ?? "",
      kind: "git",
      mode: resource.mode,
      mount: normalizeMount(resource.mount),
      ref: resource.ref?.trim() ?? "",
      tag: resource.tag?.trim() ?? "",
      url: resource.url.trim()
    });
  }

  return JSON.stringify({
    kind: "volume",
    mode: resource.mode,
    mount: normalizeMount(resource.mount),
    name: resource.name?.trim() ?? ""
  });
};

const mountsOverlap = (left: string, right: string): boolean =>
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

export const mergeWorkspaceResources = (
  inherited: TeamWorkspaceResource[] = [],
  local: TeamWorkspaceResource[] = [],
  ownerName: string
): TeamWorkspaceResource[] => {
  const merged: TeamWorkspaceResource[] = [];
  const identityById = new Map<string, string>();

  for (const resource of [...inherited, ...local]) {
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
  resource: TeamWorkspaceResource
): WorkspaceResourcePlan =>
  resource.kind === "git"
    ? {
        ...(resource.branch ? { branch: resource.branch } : {}),
        id: resource.id,
        kind: "git",
        mode: resource.mode,
        mount: normalizeMount(resource.mount),
        ...(resource.ref ? { ref: resource.ref } : {}),
        ...(resource.tag ? { tag: resource.tag } : {}),
        url: resource.url
      }
    : {
        id: resource.id,
        kind: "volume",
        mode: resource.mode,
        mount: normalizeMount(resource.mount),
        ...(resource.name ? { name: resource.name } : {})
      };

export const mergeWorkspaceResourcePlans = (
  resources: TeamWorkspaceResource[],
  ownerName: string
): WorkspaceResourcePlan[] =>
  mergeWorkspaceResources([], resources, ownerName).map(toWorkspaceResourcePlan);
