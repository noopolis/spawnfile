import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { trainingInstantSchema, type TeamWorkspaceResource } from "../../../manifest/index.js";
import { expandFeedPaths, expandFeedRefTemplate, FEED_IDENTITY_FILE, FEED_IDENTITY_VERSION,
  resolveFeedSource, type FeedExec, type FeedIdentity } from "../../../volume/index.js";
import { recordedCommitSchema } from "./contract.js";
import { resolveRecordedCommit } from "./recordedCommit.js";
import { exportFeedGitTree } from "./gitArchive.js";
import { assertLocalGitRepository } from "./gitHistory.js";
import { assertCommitNotFuture, commitAt, rewindGitSync, type SelectedCommit } from "./gitProcess.js";
import { historyKey } from "./history.js";
import { compareInstants } from "./instant.js";
import type { InputContext, InputResult } from "./types.js";

type VolumeFeed = NonNullable<Extract<TeamWorkspaceResource, { kind: "volume" }>["feed"]>;

const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const plainPath = z.string().min(1).refine((value) => !value.startsWith("/") && !/[\\\0]/u.test(value)
  && !value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git"), "Expected a plain tree-relative path");
export const feedLandingSchema = z.object({
  revision, tree: z.string().regex(/^(?:trees\/)?[a-f0-9]{64}(?:\.[1-9][0-9]*)?$/u),
  commit: recordedCommitSchema.nullable(), ref: z.string().min(1).nullable(), paths: z.array(plainPath).nullable(),
  landedAt: trainingInstantSchema
}).strict().superRefine((value, context) => {
  if (!value.tree.replace(/^trees\//u, "").startsWith(value.revision)) context.addIssue({ code: "custom", message: "Landing tree must belong to its revision" });
});
export type FeedLanding = z.infer<typeof feedLandingSchema>;

/** Equal-instant landings must agree; log order cannot break a contradictory timestamp tie. */
export const selectFeedLanding = (landings: readonly FeedLanding[], at: string): FeedLanding | null => {
  const eligible = landings.filter((landing) => compareInstants(landing.landedAt, at) <= 0);
  const selected = eligible.reduce<FeedLanding | null>((latest, entry) => !latest || compareInstants(entry.landedAt, latest.landedAt) > 0 ? entry : latest, null);
  if (selected && eligible.some((entry) => compareInstants(entry.landedAt, selected.landedAt) === 0
    && JSON.stringify({ ...entry, landedAt: "" }) !== JSON.stringify({ ...selected, landedAt: "" }))) throw new Error("Conflicting feed landings at the same instant");
  return selected;
};

const revisionExec: FeedExec = (command, args) => {
  if (command !== "git" || args[0] !== "-C" || !args[1]) throw new Error("Feed revision may only read a local git repository");
  return rewindGitSync(args[1], args.slice(2));
};
const feedPaths = (paths: string[] | null): string[] | undefined => paths?.length ? paths : undefined;

/** Same template/fallback ordering as chooseFeedRef, with historical eligibility replacing existence. */
export const selectFeedCommit = async (feed: VolumeFeed, repository: string, at: string): Promise<SelectedCommit & { ref: string }> => {
  if (!feed.git) throw new Error("Directory feed cannot be rewound without a landing log; provide an override");
  if (feed.freeze) throw new Error("Feed freeze/waiting state cannot be reconstructed without a landing log; provide an override");
  const rule = feed.git.ref;
  if (typeof rule === "object" && rule.command) throw new Error("Feed command refs cannot be evaluated historically without a landing log; provide an override");
  const selectors = typeof rule === "object" ? [expandFeedRefTemplate(rule.template!, new Date(at)), rule.fallback]
    : [rule ?? "HEAD"];
  for (const selector of selectors) {
    if (!selector) continue;
    const selected = await commitAt(repository, selector, at);
    if (selected) return { ...selected, ref: selector };
  }
  throw new Error(`No feed ref has a first-parent commit at or before ${at}`);
};

const fileCount = async (directory: string): Promise<number> => {
  let count = 0;
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), stats = await lstat(file);
    count += stats.isDirectory() ? await fileCount(file) : 1;
  }
  return count;
};

export const materializeFeed = async (context: InputContext): Promise<InputResult> => {
  const { input, history } = context;
  if (input.section !== "resources" || input.declaration.kind !== "volume" || !input.declaration.feed) throw new Error("Feed rewind requires a fed volume");
  const resource = input.declaration, feed = resource.feed!;
  if (input.overridden) {
    await mkdir(context.destination, { recursive: true });
    return { fidelity: "overridden", basis: "override", source: {}, notes: ["Volume override starts empty; no feed refresh is run."], instant: context.at };
  }
  if (!history) throw new Error(`Missing feed history for ${input.id}; --history is required`);
  const key = `feeds/${historyKey(input)}`;
  const log = await history.jsonl(`${key}/landings.jsonl`, feedLandingSchema);
  let landing: FeedLanding, repository: string | null = null;
  const openRepository = async (): Promise<string> => {
    repository ??= await history.repository(`${key}/repo`);
    if (!repository) throw new Error(`Missing feed source repository for ${input.id}`);
    await assertLocalGitRepository(repository, history);
    return repository;
  };
  for (const candidate of context.candidateRecords ?? []) {
    const entry = candidate.feeds.find((record) => record.id === input.id);
    if (entry) await resolveRecordedCommit(await openRepository(), entry.commit);
  }
  const record = context.record?.feeds.find((entry) => entry.id === input.id);
  const recordedCommit = record ? await resolveRecordedCommit(await openRepository(), record.commit) : null;
  if (log) {
    for (const entry of log) if (entry.commit) await resolveRecordedCommit(await openRepository(), entry.commit);
    const selected = selectFeedLanding(log, context.at);
    if (!selected) throw new Error(`No feed landing exists at or before ${context.at}`);
    landing = selected;
    if (record && (record.revision !== landing.revision || record.tree !== landing.tree || recordedCommit !== landing.commit
      || JSON.stringify(feedPaths(record.paths)) !== JSON.stringify(feedPaths(landing.paths)) || compareInstants(record.landedAt, landing.landedAt) !== 0)) {
      throw new Error(`Moment feed ${input.id} disagrees with its landing log`);
    }
  } else {
    // Refuse unknown historical behavior before touching any declared source or executing any command.
    if (!feed.git || feed.freeze || typeof feed.git.ref === "object" && feed.git.ref.command) await selectFeedCommit(feed, "", context.at);
    if (feed.include || feed.prepare) throw new Error("Prepared/included feed requires a landing log and retained tree bytes");
    const repo = await openRepository(), selected = await selectFeedCommit(feed, repo, context.at);
    const paths = expandFeedPaths(feed.git!.paths, new Date(context.at));
    const source = resolveFeedSource({ kind: "git", fetch: false, repo, ref: selected.commit, label: selected.ref, paths }, { exec: revisionExec });
    landing = { revision: source.revision, tree: source.revision, commit: selected.commit, ref: selected.ref, paths: paths ?? null, landedAt: selected.instant };
  }
  // Selection owns this check: retained/prepared bytes must obey the same cutoff as extraction.
  if (feed.git && (!landing.commit || !landing.ref)) throw new Error("Git feed landing must record its commit and ref");
  if (landing.commit) await assertCommitNotFuture(await openRepository(), landing.commit, context.at);
  const tree = path.join(context.destination, "trees", landing.revision);
  if (await history.path(`${key}/trees/${landing.revision}`)) await history.copyTree(`${key}/trees/${landing.revision}`, tree);
  else {
    if (!feed.git || feed.include || feed.prepare) throw new Error("Directory/prepared/included feed requires retained landed tree bytes");
    if (!landing.commit || !landing.ref) throw new Error("Git feed landing must record its commit and ref");
    const repo = await openRepository();
    const resolved = resolveFeedSource({ kind: "git", fetch: false, repo, ref: landing.commit, label: landing.ref, paths: feedPaths(landing.paths) }, { exec: revisionExec });
    if (resolved.revision !== landing.revision) throw new Error(`Feed revision mismatch: recorded ${landing.revision}, reconstructed ${resolved.revision}`);
    const commit = resolved.provenance.kind === "git" ? resolved.provenance.commit : landing.commit;
    await exportFeedGitTree(repo, commit, tree, feedPaths(landing.paths));
  }
  const files = await fileCount(tree);
  if (!files) throw new Error("Retained feed tree is empty; a fed volume never serves nothing");
  const identity: FeedIdentity = { version: FEED_IDENTITY_VERSION, resource: input.id, volume: resource.name!, revision: landing.revision,
    tree: `trees/${landing.revision}`, files, landed_at: landing.landedAt,
    source: feed.git ? { kind: "git", commit: landing.commit!, ref: landing.ref!, paths: landing.paths } : { kind: "directory" } };
  await symlink(identity.tree, path.join(context.destination, "current"));
  await writeFile(path.join(context.destination, FEED_IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`);
  return { fidelity: log ? "exact" : "approximate", basis: log ? "landing-log" : "feed-rule-at",
    source: { revision: landing.revision, ...(landing.commit ? { commit: landing.commit } : {}) }, instant: landing.landedAt,
    notes: log ? [] : ["Commit dates do not establish when a ref advanced; historical freeze holds cannot be reconstructed."] };
};
