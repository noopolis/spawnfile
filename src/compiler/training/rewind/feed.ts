import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TeamWorkspaceResource } from "../../../manifest/index.js";
import { digestDirectory, expandFeedPaths, expandFeedRefTemplate, FEED_IDENTITY_FILE, FEED_IDENTITY_VERSION,
  resolveFeedSource, type FeedExec, type FeedIdentity } from "../../../volume/index.js";
import { resolveRecordedCommit } from "./recordedCommit.js";
import { feedLandingSchema, readFeedLandingHistory, selectFeedLanding, type FeedLanding } from "./feedLandings.js";
import { exportFeedGitTree } from "./gitArchive.js";
import { assertLocalGitRepository } from "./gitHistory.js";
import { assertCommitNotFuture, commitAt, rewindGitSync, type SelectedCommit } from "./gitProcess.js";
import { historyKey } from "./history.js";
import { compareInstants } from "./instant.js";
import type { InputContext, InputResult } from "./types.js";

export { feedLandingSchema, selectFeedLanding, type FeedLanding } from "./feedLandings.js";
type VolumeFeed = NonNullable<Extract<TeamWorkspaceResource, { kind: "volume" }>["feed"]>;

const revisionExec: FeedExec = (command, args) => {
  if (command !== "git" || args[0] !== "-C" || !args[1]) throw new Error("Feed revision may only read a local git repository");
  return rewindGitSync(args[1], args.slice(2));
};
const feedPaths = (paths: string[] | undefined): string[] | undefined => paths?.length ? paths : undefined;
const treeName = (tree: string): string => tree.replace(/^trees\//u, "");

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
  const log = await readFeedLandingHistory(history, key, input.id);
  let landing: FeedLanding, repository: string | null = null, basis: string, ambiguous = false;
  const openRepository = async (): Promise<string> => {
    repository ??= await history.repository(`${key}/repo`);
    if (!repository) throw new Error(`Missing feed source repository for ${input.id}`);
    await assertLocalGitRepository(repository, history);
    return repository;
  };
  for (const [index, entry] of (log ?? []).entries()) {
    if (!entry.commit) continue;
    try { await resolveRecordedCommit(await openRepository(), entry.commit); }
    catch (error) { throw new Error(`Invalid history ${key}/landings.jsonl:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const candidate of context.candidateRecords ?? []) {
    const entry = candidate.feeds.find((record) => record.id === input.id);
    if (entry?.commit !== undefined) await resolveRecordedCommit(await openRepository(), entry.commit);
  }
  const record = context.record?.feeds.find((entry) => entry.id === input.id);
  const recordedCommit = record?.commit === undefined ? undefined : await resolveRecordedCommit(await openRepository(), record.commit);
  const matching = record ? log?.findLast((entry) => entry.revision === record.revision && treeName(entry.tree) === treeName(record.tree)
    && compareInstants(entry.landed_at, record.landedAt) === 0 && entry.commit === recordedCommit) : undefined;
  const selected = record ? null : selectFeedLanding(log ?? [], context.at);
  if (record) {
    // A wake pin is authoritative even if a later attempt or landing changed the currently selected log row.
    landing = { version: "spawnfile.volume-feed-landing.v1", resource: input.id, volume: matching?.volume ?? resource.name!,
      revision: record.revision, tree: record.tree, landed_at: record.landedAt,
      source: matching?.source ?? (feed.git ? { kind: "git", repo: feed.git.repo } : { kind: "directory", directory: feed.directory! }),
      ...(recordedCommit ? { commit: recordedCommit, ref: record.ref ?? recordedCommit } : {}),
      ...(record.paths ? { paths: record.paths } : {}), ...(record.period ? { period: record.period } : {}),
      ...(matching?.switching_at ? { switching_at: matching.switching_at } : {}) };
    basis = "record";
  } else if (selected) {
    landing = selected.landing; ambiguous = selected.ambiguous; basis = "landing-log";
  } else {
    // Refuse unknown historical behavior before touching any declared source or executing any command.
    if (!feed.git || feed.freeze || typeof feed.git.ref === "object" && feed.git.ref.command) await selectFeedCommit(feed, "", context.at);
    if (feed.include || feed.prepare) throw new Error("Prepared/included feed requires a landing log and retained tree bytes");
    const repo = await openRepository(), commit = await selectFeedCommit(feed, repo, context.at);
    const paths = expandFeedPaths(feed.git!.paths, new Date(context.at));
    const source = resolveFeedSource({ kind: "git", fetch: false, repo, ref: commit.commit, label: commit.ref, paths }, { exec: revisionExec });
    landing = { version: "spawnfile.volume-feed-landing.v1", resource: input.id, volume: resource.name!,
      revision: source.revision, tree: source.revision, source: { kind: "git", repo: feed.git!.repo },
      commit: commit.commit, ref: commit.ref, ...(paths ? { paths } : {}), landed_at: commit.instant };
    basis = "feed-rule-at";
  }
  landing = feedLandingSchema.parse(landing);
  // Selection owns this check: retained/prepared bytes must obey the same cutoff as extraction.
  if (landing.source.kind === "git" && (!landing.commit || !landing.ref)) throw new Error("Git feed landing must record its commit and ref");
  if (landing.commit) {
    landing.commit = await resolveRecordedCommit(await openRepository(), landing.commit);
    await assertCommitNotFuture(await openRepository(), landing.commit, context.at);
  }
  const retainedName = treeName(landing.tree), tree = path.join(context.destination, "trees", retainedName);
  const needsRetained = landing.source.kind === "directory" || landing.source.prepared !== undefined
    || basis === "record" && !matching && (feed.include !== undefined || feed.prepare !== undefined);
  if (await history.path(`${key}/trees/${retainedName}`)) await history.copyTree(`${key}/trees/${retainedName}`, tree);
  else {
    if (needsRetained) throw new Error("Directory/prepared/included feed requires retained landed tree bytes");
    if (!landing.commit || !landing.ref) throw new Error("Git feed landing must record its commit and ref");
    const repo = await openRepository();
    const resolved = resolveFeedSource({ kind: "git", fetch: false, repo, ref: landing.commit, label: landing.ref, paths: feedPaths(landing.paths) }, { exec: revisionExec });
    if (resolved.revision !== landing.revision) throw new Error(`Feed revision mismatch: recorded ${landing.revision}, reconstructed ${resolved.revision}`);
    const commit = resolved.provenance.kind === "git" ? resolved.provenance.commit : landing.commit;
    await exportFeedGitTree(repo, commit, tree, feedPaths(landing.paths));
  }
  if (landing.source.kind === "directory") {
    const actual = digestDirectory(tree);
    if (actual !== landing.revision) throw new Error(`Directory feed revision mismatch: recorded ${landing.revision}, retained ${actual}`);
  }
  const files = await fileCount(tree);
  if (!files) throw new Error("Retained feed tree is empty; a fed volume never serves nothing");
  const prepared = landing.source.prepared ? { prepared: landing.source.prepared } : {};
  const identity: FeedIdentity = { version: FEED_IDENTITY_VERSION, resource: input.id, volume: landing.volume, revision: landing.revision,
    tree: `trees/${retainedName}`, files, landed_at: landing.landed_at,
    source: landing.source.kind === "git" ? { kind: "git", commit: landing.commit!, ref: landing.ref!, paths: landing.paths ?? null, ...prepared }
      : { kind: "directory", ...prepared } };
  await symlink(identity.tree, path.join(context.destination, "current"));
  await writeFile(path.join(context.destination, FEED_IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`);
  return { fidelity: basis === "feed-rule-at" || ambiguous ? "approximate" : "exact", basis,
    source: { revision: landing.revision, landedAt: landing.landed_at, ...(landing.switching_at ? { switchingAt: landing.switching_at } : {}),
      ...(landing.commit ? { commit: landing.commit } : {}) },
    instant: compareInstants(landing.landed_at, context.at) > 0 ? context.at : landing.landed_at,
    notes: ambiguous ? ["The trial instant falls inside an ambiguous feed transition; the incoming landing is used."]
      : basis === "feed-rule-at" ? ["Commit dates do not establish when a ref advanced; historical freeze holds cannot be reconstructed."] : [] };
};
