import { z } from "zod";

import { argvSchema, pinnedImageSchema } from "./commandSchemas.js";

/** `${date}` (UTC) or `${date:<IANA zone>}`: the local date (YYYY-MM-DD) at refresh time. The only placeholder a ref template knows. */
export const FEED_REF_PLACEHOLDER = /\$\{date(?::([^}]*))?\}/gu;
export const FEED_CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export const isFeedTimeZone = (zone: string): boolean => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone.trim() !== ""; } catch { return false; }
};

const plainRelativePath = (entry: string): boolean =>
  !entry.startsWith("/") && !entry.split("/").some((segment) => segment === ".." || segment === "." || segment === "");

/** A ref resolved per refresh: a template or a command printing a ref, with an optional fallback when it does not exist yet. */
const volumeFeedRefRuleSchema = z.object({
  command: argvSchema.optional(),
  fallback: z.string().trim().min(1).optional(),
  template: z.string().trim().min(1).optional()
}).strict().superRefine((value, context) => {
  if ((value.command === undefined) === (value.template === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a volume feed ref rule must declare exactly one of template or command" });
  }
  if (value.template === undefined) return;
  for (const match of value.template.matchAll(FEED_REF_PLACEHOLDER)) {
    if (match[1] !== undefined && !isFeedTimeZone(match[1])) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `volume feed ref template time zone ${JSON.stringify(match[1])} is not an IANA time zone` });
    }
  }
  if (value.template.replace(FEED_REF_PLACEHOLDER, "").includes("${")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "volume feed ref templates know only ${date} and ${date:<time zone>}" });
  }
});

/**
 * Host-fed content for a volume: a host directory or a git ref Spawnfile copies into the volume by atomic
 * swap (`spawnfile volume refresh`), never through the image. Exactly one source per feed.
 */
export const volumeFeedSchema = z.object({
  directory: z.string().trim().min(1).optional(),
  /** Once local time passes `after`, a volume that already landed this period's ref stops advancing until the period or the ref changes. */
  freeze: z.object({
    after: z.string().regex(FEED_CLOCK_PATTERN, "freeze.after must be HH:MM (24-hour)"),
    timezone: z.string().trim().min(1).refine(isFeedTimeZone, "freeze.timezone must be an IANA time zone")
  }).strict().optional(),
  git: z.object({
    fetch: z.boolean().optional(),
    paths: z.array(z.string().trim().min(1)).min(1).optional(),
    ref: z.union([z.string().trim().min(1), volumeFeedRefRuleSchema]).optional(),
    repo: z.string().trim().min(1)
  }).strict().optional(),
  /** Host directories (files not in the source, e.g. fonts) staged into the tree before `prepare`. */
  include: z.array(z.object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1)
  }).strict()).min(1).optional(),
  keep: z.number().int().min(1).optional(),
  owner: z.string().regex(/^\d+:\d+$/u, "owner must be <uid>:<gid>").optional(),
  /** A command run inside the staged tree after fetch and before validate: in a digest-pinned image, or explicitly on the host. */
  prepare: z.object({
    command: argvSchema,
    host: z.literal(true).optional(),
    image: pinnedImageSchema.optional(),
    network: z.boolean().optional(),
    platform: z.enum(["linux/amd64", "linux/arm64"]).optional(),
    timeout_seconds: z.number().int().positive().max(86_400).optional()
  }).strict().superRefine((value, context) => {
    if ((value.image === undefined) === (value.host === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "volume feed prepare must declare exactly one of image (digest-pinned) or host: true" });
    }
    if (value.host && (value.platform !== undefined || value.network !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "volume feed prepare platform and network apply only to an image" });
    }
  }).optional(),
  validate: z.array(z.string().min(1)).min(1).optional()
}).strict().superRefine((value, context) => {
  if ((value.directory === undefined) === (value.git === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "volume feeds must declare exactly one of directory or git" });
  }
  for (const entry of value.git?.paths ?? []) {
    if (!plainRelativePath(entry)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `volume feed git path ${entry} must be a plain repository-relative path` });
    }
  }
  const targets = (value.include ?? []).map((entry) => entry.to);
  for (const [index, to] of targets.entries()) {
    if (!plainRelativePath(to)) context.addIssue({ code: z.ZodIssueCode.custom, message: `volume feed include target ${to} must be a plain tree-relative path` });
    if (targets.some((other, at) => at !== index && (other === to || other.startsWith(`${to}/`)))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `volume feed include target ${to} overlaps another include` });
    }
  }
});

export type VolumeFeedRefRule = z.infer<typeof volumeFeedRefRuleSchema>;
