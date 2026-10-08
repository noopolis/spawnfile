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

const teamWorkspaceResourceVolumeSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.literal("volume"),
    mount: resourceMountSchema,
    mode: workspaceResourceModeSchema,
    name: z.string().trim().optional(),
    sharing: workspaceResourceSharingSchema.optional()
  })
  .strict();

/** Declared inputs Spawnfile builds into the bundle archive. Exactly one input kind per bundle. */
const workspaceBundleBuildSchema = z.object({
  files: z.object({
    exclude: z.array(z.string().trim().min(1)).optional(),
    root: z.string().trim().min(1)
  }).strict()
}).strict();

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
export type TeamWorkspaceSkill = z.infer<typeof workspaceSkillReferenceSchema>;
