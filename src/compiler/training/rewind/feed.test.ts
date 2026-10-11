import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TeamWorkspaceResource } from "../../../manifest/index.js";
import { digestDirectory, feedIdentityFindings, resolveFeedSource } from "../../../volume/index.js";
import { feedLandingSchema, materializeFeed, selectFeedLanding, type FeedLanding } from "./feed.js";
import { History } from "./history.js";
import { commitTestGit, gitTestRoot, initTestGit, testGit, testMomentRecord } from "./git.test-helper.js";
import type { InputContext } from "./types.js";
import { stampTree } from "./timestamps.js";

const AT = "2026-10-09T08:20:31Z", EARLY = "2026-10-09T08:00:00Z", LATE = "2026-10-09T09:00:00Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await gitTestRoot(); roots.push(root);
  const directory = path.join(root, "history/feeds/agent%3Awriter/news"), repository = path.join(directory, "repo");
  await initTestGit(repository);
  const past = await commitTestGit(repository, { "published/news.txt": "past\n", "ignored/private.txt": "not-fed\n" }, EARLY);
  const future = await commitTestGit(repository, { "published/news.txt": "future\n" }, LATE);
  const revision = resolveFeedSource({ kind: "git", fetch: false, repo: repository, ref: past, paths: ["published"] }).revision;
  const landing: FeedLanding = { revision, tree: revision, commit: past, ref: "main", paths: ["published"], landedAt: EARLY };
  const resource: TeamWorkspaceResource = { id: "news", kind: "volume", mode: "mutable", mount: "./news", name: "org-news",
    feed: { git: { repo: "https://never-fetch.invalid/source", ref: "main", paths: ["published"], fetch: true } } };
  const context: InputContext = { at: AT, destination: path.join(root, "output"), history: new History(path.join(root, "history")), record: null,
    input: { section: "resources", declaredBy: "agent:writer", id: "news", declarationBase: root, overridden: false, declaration: resource } };
  const log = async (entries: FeedLanding[]) => writeFile(path.join(directory, "landings.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { root, repository, directory, past, future, revision, landing, context, resource, log };
};

describe("feed rewind", () => {
  it.each(["retained", "reconstructed"].flatMap((bytes) => ["author", "committer"].map((role) => [bytes, role])))
    ("refuses a future selected commit before using %s bytes (%s date)", async (bytes, role) => {
      const { context, repository, past, directory, landing, log } = await fixture();
      testGit(repository, ["checkout", "--detach", past]);
      testGit(repository, ["commit", "--allow-empty", "-m", "future metadata", `--date=${role === "author" ? LATE : EARLY}`], role === "committer" ? LATE : EARLY);
      const commit = testGit(repository, ["rev-parse", "HEAD"]);
      const revision = resolveFeedSource({ kind: "git", fetch: false, repo: repository, ref: commit, paths: ["published"] }).revision;
      await log([{ ...landing, commit, revision, tree: revision, landedAt: EARLY }]);
      if (bytes === "retained") {
        const retained = path.join(directory, "trees", revision);
        await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "future.txt"), "future retained bytes");
        await stampTree(retained, EARLY, AT);
      }
      await expect(materializeFeed(context)).rejects.toThrow(`Selected commit ${commit} has an author or committer date after ${AT}`);
      await expect(readdir(context.destination)).rejects.toThrow();
    });

  it("selects exact boundary landings and matches offset-equivalent records", async () => {
    const { context, landing, log, revision } = await fixture();
    const selected = { ...landing, landedAt: AT };
    await log([selected, { ...landing, revision: "f".repeat(64), tree: "f".repeat(64), landedAt: "2026-10-09T08:20:31.001Z" }]);
    context.record = { ...testMomentRecord(), feeds: [{ id: "news", revision, tree: revision, commit: landing.commit!, paths: ["published"], landedAt: "2026-10-09T10:20:31+02:00" }] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "landing-log", source: { commit: landing.commit, revision }, instant: AT });
    expect(await readlink(path.join(context.destination, "current"))).toBe(`trees/${revision}`);
    expect(await readFile(path.join(context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
    const identity = JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8"));
    expect(feedIdentityFindings(identity)).toEqual([]);
    expect(identity).toMatchObject({ landed_at: AT, files: 1, source: { commit: landing.commit, paths: ["published"], ref: "main" } });
  });

  it("falls back to the feed rule at the trial instant with historical committer landing time", async () => {
    const { context, past, revision } = await fixture();
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "approximate", basis: "feed-rule-at", source: { commit: past, revision }, instant: "2026-10-09T08:00:00.000Z" });
    const identity = JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8"));
    expect(Date.parse(identity.landed_at)).toBeLessThanOrEqual(Date.parse(AT));
    expect(await readdir(path.join(context.destination, "current"))).toEqual(["published"]);
  });

  it("expands the Berlin date in both ref and paths near UTC midnight", async () => {
    const { context, resource, repository } = await fixture();
    const commit = await commitTestGit(repository, { "2026-10-10/news.txt": "Berlin tomorrow\n" }, "2026-10-09T22:00:00Z");
    testGit(repository, ["branch", "daily/2026-10-10", commit]);
    resource.feed = { git: { repo: repository, ref: { template: "daily/${date:Europe/Berlin}" }, paths: ["${date:Europe/Berlin}"] } };
    context.at = "2026-10-09T22:30:00Z";
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "approximate", source: { commit } });
    expect(await readFile(path.join(context.destination, "current/2026-10-10/news.txt"), "utf8")).toBe("Berlin tomorrow\n");
    expect(JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8")).source).toMatchObject({ ref: "daily/2026-10-10", paths: ["2026-10-10"] });
  });

  it("uses fallback when the primary ref exists but has no commit at or before at", async () => {
    const { context, resource, repository, past } = await fixture();
    testGit(repository, ["checkout", "--orphan", "daily/2026-10-09"]);
    await commitTestGit(repository, { "published/news.txt": "future orphan\n" }, LATE);
    resource.feed!.git!.ref = { template: "daily/${date}", fallback: "main" };
    expect(await materializeFeed(context)).toMatchObject({ source: { commit: past } });
    expect(JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8")).source.ref).toBe("main");
  });

  it("uses retained trees for prepared feeds without executing the recipe or ref command", async () => {
    const { context, resource, directory, landing, log } = await fixture();
    resource.feed = { git: { repo: "never-used", ref: { command: ["never-run-ref"] } }, freeze: { timezone: "UTC", after: "08:00" },
      include: [{ from: "not-on-disk", to: "assets" }], prepare: { host: true, command: ["never-run-prepare"] } };
    const retained = path.join(directory, "trees", landing.revision);
    await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "prepared.txt"), "retained\n");
    await log([{ ...landing, tree: `${landing.revision}.2` }]);
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "landing-log" });
    expect(await readFile(path.join(context.destination, "current/prepared.txt"), "utf8")).toBe("retained\n");
  });

  it("uses retained directory feed landings and starts overridden feeds empty", async () => {
    const { context, resource, directory, log } = await fixture();
    resource.feed = { directory: "never-read" };
    const retainedTemp = path.join(directory, "retained"); await mkdir(retainedTemp); await writeFile(path.join(retainedTemp, "data.txt"), "directory\n");
    const revision = digestDirectory(retainedTemp), retained = path.join(directory, "trees", revision);
    await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "data.txt"), "directory\n");
    await log([{ revision, tree: revision, commit: null, ref: null, paths: null, landedAt: EARLY }]);
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", source: { revision } });
    expect(await readFile(path.join(context.destination, "current/data.txt"), "utf8")).toBe("directory\n");
    await rm(context.destination, { recursive: true }); context.input.overridden = true; context.history = undefined;
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "overridden", basis: "override" });
    expect(await readdir(context.destination)).toEqual([]);
  });

  it("refuses revision mismatches and disagreements with the moment record", async () => {
    const { context, landing, log } = await fixture();
    await log([{ ...landing, revision: "0".repeat(64), tree: "0".repeat(64) }]);
    await expect(materializeFeed(context)).rejects.toThrow("Feed revision mismatch");
    await log([landing]);
    context.record = { ...testMomentRecord(), feeds: [{ id: "news", revision: "f".repeat(64), tree: landing.tree,
      commit: landing.commit!, paths: ["published"], landedAt: EARLY }] };
    await expect(materializeFeed(context)).rejects.toThrow("disagrees with its landing log");
  });

  it("refuses nonhistorical feed rules and missing retained prepared bytes", async () => {
    const { context, resource, landing, log } = await fixture();
    resource.feed = { directory: "never-read" };
    await expect(materializeFeed(context)).rejects.toThrow("Directory feed cannot be rewound");
    resource.feed = { git: { repo: "never-read", ref: { command: ["never-execute"] } } };
    await expect(materializeFeed(context)).rejects.toThrow("command refs cannot be evaluated");
    resource.feed = { git: { repo: "never-read" }, freeze: { after: "08:00", timezone: "UTC" } };
    await expect(materializeFeed(context)).rejects.toThrow("freeze/waiting");
    resource.feed = { git: { repo: "never-read" }, prepare: { host: true, command: ["never-execute"] } };
    await log([landing]);
    await expect(materializeFeed(context)).rejects.toThrow("retained landed tree bytes");
    context.history = undefined;
    await expect(materializeFeed(context)).rejects.toThrow("--history is required");
  });

  it("validates every landing line and refuses no eligible landing", async () => {
    const { context, directory, landing, log } = await fixture();
    await log([{ ...landing, landedAt: LATE }]);
    await expect(materializeFeed(context)).rejects.toThrow("No feed landing");
    await writeFile(path.join(directory, "landings.jsonl"), `${JSON.stringify(landing)}\n${JSON.stringify({ ...landing, unknown: true })}\n`);
    await expect(materializeFeed(context)).rejects.toThrow(/landings.jsonl:2/u);
    await writeFile(path.join(directory, "landings.jsonl"), "");
    await expect(materializeFeed(context)).rejects.toThrow("No feed landing");
  });

  it("ignores archive attributes and preserves long names when reconstructing feed bytes", async () => {
    const { context, repository, resource } = await fixture();
    const longName = `published/${"x".repeat(150)}.txt`;
    const commit = await commitTestGit(repository, { ".gitattributes": "published/hidden.txt export-ignore\npublished/version.txt export-subst\n",
      "published/hidden.txt": "omitted\n", "published/version.txt": "$Format:%H$\n", [longName]: "long\n" }, "2026-10-09T08:10:00Z");
    resource.feed!.git!.ref = commit;
    await materializeFeed(context);
    expect(await readFile(path.join(context.destination, "current/published/version.txt"), "utf8")).toBe("$Format:%H$\n");
    expect(await readFile(path.join(context.destination, "current", longName), "utf8")).toBe("long\n");
    expect(await readFile(path.join(context.destination, "current/published/hidden.txt"), "utf8")).toBe("omitted\n");
  });

  it("refuses retained history symlinks outside the history root", async () => {
    const { context, directory, landing, log } = await fixture();
    const retained = path.join(directory, "trees", landing.revision);
    await mkdir(retained, { recursive: true }); await symlink("/etc/passwd", path.join(retained, "escape")); await log([landing]);
    await expect(materializeFeed(context)).rejects.toThrow("History symlink escape");
  });

  it("selects pure instant boundaries and refuses contradictory equal-instant landings", () => {
    const revision = "a".repeat(64), landing = feedLandingSchema.parse({ revision, tree: revision, commit: "a".repeat(40), ref: "main", paths: [], landedAt: AT });
    expect(selectFeedLanding([landing], "2026-10-09T10:20:31+02:00")).toBe(landing);
    expect(selectFeedLanding([landing], "2026-10-09T08:20:30.999Z")).toBeNull();
    expect(() => selectFeedLanding([landing, { ...landing, commit: "b".repeat(40), landedAt: "2026-10-09T10:20:31+02:00" }], AT)).toThrow("Conflicting feed landings");
  });
});
