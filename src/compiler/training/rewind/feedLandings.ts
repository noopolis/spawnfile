import { z } from "zod";
import { trainingInstantSchema } from "../../../manifest/index.js";
import { recordedCommitSchema } from "./contract.js";
import type { History } from "./history.js";
import { compareInstants } from "./instant.js";

const text = z.string().min(1), revision = z.string().regex(/^[a-f0-9]{64}$/u);
const plainPath = text.refine((value) => !value.startsWith("/") && !/[\\\0]/u.test(value)
  && !value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git"), "Expected a plain tree-relative path");
const prepared = z.object({
  source_revision: revision,
  include: z.array(z.object({ digest: revision, to: plainPath }).strict()),
  prepare: z.object({ command: z.array(text).min(1), image: text.nullable(), network: z.boolean().nullable(), platform: text.nullable() }).strict().nullable()
}).strict();

// Recording-format compatibility boundary: replace with readFeedLandings/feedLandingAt after P3 merges.
export const feedLandingSchema = z.object({
  version: z.literal("spawnfile.volume-feed-landing.v1"), resource: text, volume: text,
  revision, tree: z.string().regex(/^(?:trees\/)?[a-f0-9]{64}(?:\.[1-9][0-9]*)?$/u),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("git"), repo: text, prepared: prepared.optional() }).strict(),
    z.object({ kind: z.literal("directory"), directory: text, prepared: prepared.optional() }).strict()
  ]),
  commit: recordedCommitSchema.optional(), ref: text.optional(), paths: z.array(plainPath).optional(),
  switching_at: trainingInstantSchema.optional(), landed_at: trainingInstantSchema, period: text.optional()
}).strict().superRefine((value, context) => {
  if (!value.tree.replace(/^trees\//u, "").startsWith(value.revision)) context.addIssue({ code: "custom", message: "Landing tree must belong to its revision" });
  if (value.source.kind === "git" && (!value.commit || !value.ref)) context.addIssue({ code: "custom", message: "Git feed landing must record its commit and ref" });
  if (value.source.kind === "directory" && (value.commit !== undefined || value.ref !== undefined || value.paths !== undefined)) {
    context.addIssue({ code: "custom", message: "Directory feed landing cannot carry git provenance" });
  }
  if (value.switching_at && compareInstants(value.switching_at, value.landed_at) > 0) {
    context.addIssue({ code: "custom", message: "Landing transition begins after landed_at" });
  }
});
export type FeedLanding = z.infer<typeof feedLandingSchema>;
export interface FeedLandingSelection { landing: FeedLanding; ambiguous: boolean }

export const readFeedLandingHistory = async (history: History, key: string, resource: string): Promise<FeedLanding[] | null> =>
  history.jsonl(`${key}/landings.jsonl`, feedLandingSchema.refine((entry) => entry.resource === resource,
    "Landing resource disagrees with the history input"));

/** Inclusive transition windows take priority; equal-instant state uses the last appended row. */
export const selectFeedLanding = (landings: readonly FeedLanding[], at: string): FeedLandingSelection | null => {
  let transition: FeedLanding | null = null, selected: FeedLanding | null = null;
  for (const landing of landings) {
    if (landing.switching_at && compareInstants(landing.switching_at, at) <= 0 && compareInstants(at, landing.landed_at) <= 0) transition = landing;
    if (compareInstants(landing.landed_at, at) <= 0 && (!selected || compareInstants(landing.landed_at, selected.landed_at) >= 0)) selected = landing;
  }
  return transition ? { landing: transition, ambiguous: true } : selected ? { landing: selected, ambiguous: false } : null;
};
