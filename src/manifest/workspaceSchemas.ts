import { z } from "zod";

const workspaceResourceModeSchema = z.enum(["mutable", "readonly"]);

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
  const collapsed = value.trim().replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : "/";
};

const resourceMountSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    if (!value.startsWith("/")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mount must be an absolute POSIX path"
      });
    }
  });

const teamWorkspaceResourceGitSchema = z
  .object({
    branch: z.string().trim().optional(),
    id: z.string().trim().min(1),
    kind: z.literal("git"),
    mount: resourceMountSchema,
    mode: workspaceResourceModeSchema,
    ref: z.string().trim().optional(),
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
  });

const teamWorkspaceResourceVolumeSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.literal("volume"),
    mount: resourceMountSchema,
    mode: workspaceResourceModeSchema,
    name: z.string().trim().optional()
  })
  .strict();

const teamWorkspaceResourceSchema = z.discriminatedUnion("kind", [
  teamWorkspaceResourceGitSchema,
  teamWorkspaceResourceVolumeSchema
]);

export const teamWorkspaceSchema = z
  .object({
    docs: teamWorkspaceDocsSchema.optional(),
    resources: z.array(teamWorkspaceResourceSchema).optional()
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
          branch: resource.branch?.trim() ?? "",
          kind: "git",
          mode: resource.mode,
          mount: normalizeMount(resource.mount),
          ref: resource.ref?.trim() ?? "",
          tag: resource.tag?.trim() ?? "",
          url: resource.url
        });
      }

      return JSON.stringify({
        kind: "volume",
        mode: resource.mode,
        mount: normalizeMount(resource.mount),
        name: resource.name?.trim() ?? ""
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
