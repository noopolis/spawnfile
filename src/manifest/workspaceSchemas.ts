import { z } from "zod";

const workspaceResourceModeSchema = z.enum(["mutable", "readonly"]);
const workspaceResourceSharingSchema = z.enum(["per_agent", "team"]);

export const teamWorkspaceDocsSchema = z
  .object({
    extras: z.record(z.string(), z.string()).optional(),
    heartbeat: z.string().min(1).optional(),
    identity: z.string().min(1).optional(),
    memory: z.string().min(1).optional(),
    soul: z.string().min(1).optional(),
    system: z.string().min(1).optional()
  })
  .strict();

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

const mountHasParentSegment = (value: string): boolean =>
  value.split("/").some((segment) => segment === "..");

const resourceMountSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    const normalized = normalizeMount(value);
    if (mountHasParentSegment(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mount must not contain parent path segments"
      });
    }
    if (normalized === "." || normalized === "./" || normalized === "${workspace}") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mount must point inside the workspace, not at the workspace root"
      });
    }
    if (
      !normalized.startsWith("/") &&
      !normalized.startsWith("./") &&
      !normalized.startsWith("${workspace}/")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mount must be an absolute POSIX path, ./ workspace path, or ${workspace}/ path"
      });
    }
  });

/** Host-side credentials for a `fetch: build` git resource: a key file path, or an env var holding the key. */
const gitResourceAuthSchema = z
  .object({
    ssh_key: z.string().trim().min(1).optional(),
    ssh_key_env: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "ssh_key_env must be an environment variable name").optional()
  })
  .strict()
  .refine((value) => (value.ssh_key === undefined) !== (value.ssh_key_env === undefined), {
    message: "git resource auth must declare exactly one of ssh_key or ssh_key_env"
  });

/**
 * True when a URL may carry a credential: any password, any userinfo on a
 * non-SSH URL (a token is often sent as the user name), or a query string.
 * An SSH user name (`git@host:...`, `ssh://git@host/...`) is not a secret.
 */
const urlEmbedsCredential = (url: string): boolean => {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/iu.exec(url);
  if (!scheme) return url.includes("?");
  const authority = scheme[2]!, userinfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : undefined;
  if (url.includes("?") || userinfo?.includes(":")) return true;
  return userinfo !== undefined && !/^(ssh|git\+ssh|ssh\+git)$/iu.test(scheme[1]!);
};

const teamWorkspaceResourceGitSchema = z
  .object({
    auth: gitResourceAuthSchema.optional(),
    branch: z.string().trim().optional(),
    exclude: z.array(z.string().trim().min(1)).optional(),
    fetch: z.enum(["start", "build"]).optional(),
    id: z.string().trim().min(1),
    kind: z.literal("git"),
    mount: resourceMountSchema,
    mode: workspaceResourceModeSchema,
    ref: z.string().trim().optional(),
    sharing: workspaceResourceSharingSchema.optional(),
    tag: z.string().trim().optional(),
    url: z.string().trim().min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const selectors = [value.branch, value.tag, value.ref].filter(Boolean).length;
    if (selectors > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "git resources may declare at most one of branch, tag, or ref"
      });
    }
    if (value.fetch === "build") {
      if ([value.branch, value.tag, value.ref].some((selector) => selector !== undefined && selector === "")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "git resource branch, tag, or ref must not be empty with fetch: build" });
      }
      if (value.mode !== "readonly") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "git resources with fetch: build are pinned image content and must be mode: readonly" });
      }
      if (urlEmbedsCredential(value.url)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "git resource url must not embed a credential; declare auth instead" });
      }
    } else {
      if (value.auth !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "git resource auth requires fetch: build; a container-start clone never receives host credentials" });
      }
      if (value.exclude !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "git resource exclude requires fetch: build" });
      }
    }
    if (value.sharing === "team") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "git resources do not support team sharing"
      });
    }
  });

/**
 * Host-fed content for a volume: a host directory or a git ref Spawnfile copies into the volume by atomic
 * swap (`spawnfile volume refresh`), never through the image. Exactly one source per feed.
 */
const volumeFeedSchema = z.object({
  directory: z.string().trim().min(1).optional(),
  git: z.object({
    fetch: z.boolean().optional(),
    paths: z.array(z.string().trim().min(1)).min(1).optional(),
    ref: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1)
  }).strict().optional(),
  keep: z.number().int().min(1).optional(),
  owner: z.string().regex(/^\d+:\d+$/u, "owner must be <uid>:<gid>").optional(),
  validate: z.array(z.string().min(1)).min(1).optional()
}).strict().superRefine((value, context) => {
  if ((value.directory === undefined) === (value.git === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "volume feeds must declare exactly one of directory or git" });
  }
  for (const entry of value.git?.paths ?? []) {
    if (entry.startsWith("/") || entry.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `volume feed git path ${entry} must be a plain repository-relative path` });
    }
  }
});

const teamWorkspaceResourceVolumeSchema = z
  .object({
    feed: volumeFeedSchema.optional(),
    id: z.string().trim().min(1),
    kind: z.literal("volume"),
    mount: resourceMountSchema,
    mode: workspaceResourceModeSchema,
    name: z.string().trim().optional(),
    sharing: workspaceResourceSharingSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.feed) return;
    // The host job addresses the volume by its exact host name, so a derived, unpublished name cannot be fed.
    if (!value.name) context.addIssue({ code: z.ZodIssueCode.custom, message: "fed volumes must declare name" });
    // A readonly volume is made read-only by the container rewriting the whole volume on every start;
    // a fed volume is instead frozen tree by tree on the host, so it stays mutable at the mount.
    if (value.mode !== "mutable") context.addIssue({ code: z.ZodIssueCode.custom, message: "fed volumes must declare mode: mutable; the host freezes every landed tree" });
  });

/** Declared inputs Spawnfile builds into the bundle archive. Exactly one input kind per bundle. */
// A plain image reference (registry/repo[:tag]) pinned by digest; never anything Docker could read as an option.
const pinnedImageSchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/u, "image must be a reference pinned by @sha256 digest");
const argvSchema = z.array(z.string().min(1)).min(1);
const workspaceBundleFilesSchema = z.object({
  exclude: z.array(z.string().trim().min(1)).optional(),
  /** Archive the tree of this commit (any git revision) instead of the work tree; needs no clean checkout. */
  ref: z.string().trim().min(1).optional(),
  root: z.string().trim().min(1)
}).strict();

/**
 * Declared inputs Spawnfile builds into the bundle archive. Exactly one input kind per bundle:
 * `files` (git-tracked files), `dependencies` (lockfile installed for the target platform in a
 * pinned image) or `generated` (a declared command writing an output directory from declared inputs).
 */
const workspaceBundleBuildSchema = z.object({
  dependencies: z.object({
    check: argvSchema.optional(),
    dev: z.boolean().optional(),
    directory: z.string().trim().min(1),
    image: pinnedImageSchema,
    manager: z.literal("npm").optional(),
    scripts: z.boolean().optional()
  }).strict().optional(),
  files: workspaceBundleFilesSchema.optional(),
  generated: z.object({
    command: argvSchema,
    cwd: z.string().trim().min(1).optional(),
    image: pinnedImageSchema.optional(),
    inputs: z.array(workspaceBundleFilesSchema).min(1),
    timeout_seconds: z.number().int().positive().max(86_400).optional(),
    tools: z.array(argvSchema).optional()
  }).strict().optional()
}).strict().superRefine((value, context) => {
  if ([value.files, value.dependencies, value.generated].filter((kind) => kind !== undefined).length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "bundle build must declare exactly one of files, dependencies or generated" });
  }
});

const teamWorkspaceResourceBundleSchema = z.object({
  build: workspaceBundleBuildSchema.optional(),
  id: z.string().trim().min(1), kind: z.literal("bundle"), mount: resourceMountSchema,
  mode: z.literal("readonly"), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  sharing: z.literal("per_agent").optional(), source: z.string().trim().min(1).optional()
}).strict().superRefine((value, context) => {
  if ((value.source === undefined) === (value.build === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "bundle resources must declare exactly one of source or build" });
  }
});

const teamWorkspaceResourceSchema = z.discriminatedUnion("kind", [
  teamWorkspaceResourceGitSchema,
  teamWorkspaceResourceBundleSchema,
  teamWorkspaceResourceVolumeSchema
]);

const workspaceSkillRequirementSchema = z
  .object({
    mcp: z.array(z.string()).optional()
  })
  .strict();

const workspaceSkillReferenceSchema = z
  .object({
    ref: z.string(),
    requires: workspaceSkillRequirementSchema.optional()
  })
  .strict();

export const teamWorkspaceSchema = z
  .object({
    docs: teamWorkspaceDocsSchema.optional(),
    resources: z.array(teamWorkspaceResourceSchema).optional(),
    skills: z.array(workspaceSkillReferenceSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const resources = value.resources;
    if (!resources || resources.length === 0) {
      return;
    }

    const normalizeResourceIdentity = (
      resource: z.infer<typeof teamWorkspaceResourceSchema>
    ): string => {
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
          sharing: resource.sharing ?? "per_agent",
          tag: resource.tag?.trim() ?? "",
          url: resource.url
        });
      }
      if (resource.kind === "bundle") return JSON.stringify({
        build: resource.build ?? null, kind: resource.kind, mode: resource.mode, mount: normalizeMount(resource.mount),
        sha256: resource.sha256 ?? null, sharing: resource.sharing ?? "per_agent", source: resource.source ?? null
      });

      return JSON.stringify({
        ...(resource.feed ? { feed: resource.feed } : {}),
        kind: "volume",
        mode: resource.mode,
        mount: normalizeMount(resource.mount),
        name: resource.name?.trim() ?? "",
        sharing: resource.sharing ?? "per_agent"
      });
    };

    for (let leftIndex = 0; leftIndex < resources.length; leftIndex += 1) {
      const leftResource = resources[leftIndex];
      const leftNormalizedIdentity = normalizeResourceIdentity(leftResource);
      const leftMount = normalizeMount(leftResource.mount);

      for (let rightIndex = leftIndex + 1; rightIndex < resources.length; rightIndex += 1) {
        const rightResource = resources[rightIndex];
        const rightNormalizedIdentity = normalizeResourceIdentity(rightResource);
        const rightMount = normalizeMount(rightResource.mount);

        if (leftResource.id === rightResource.id && leftNormalizedIdentity !== rightNormalizedIdentity) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `resource id ${leftResource.id} must use identical resource declarations`
          });
        }

        if (
          leftMount === rightMount ||
          leftMount.startsWith(`${rightMount}/`) ||
          rightMount.startsWith(`${leftMount}/`)
        ) {
          if (leftResource.id !== rightResource.id) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `resources ${leftResource.id} and ${rightResource.id} use overlapping mounts`
            });
          }
        }
      }
    }
  });

export type TeamWorkspace = z.infer<typeof teamWorkspaceSchema>;
export type TeamWorkspaceDocs = z.infer<typeof teamWorkspaceDocsSchema>;
export type TeamWorkspaceResource = z.infer<typeof teamWorkspaceResourceSchema>;
export type WorkspaceBundleBuild = z.infer<typeof workspaceBundleBuildSchema>;
export type VolumeFeed = z.infer<typeof volumeFeedSchema>;
export type TeamWorkspaceSkill = z.infer<typeof workspaceSkillReferenceSchema>;
