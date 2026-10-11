import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TeamWorkspaceResource } from "../../../manifest/index.js";
import { digestDirectory, feedIdentityFindings, resolveFeedSource, type FeedLanding } from "../../../volume/index.js";
import { materializeFeed } from "./feed.js";
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
  const landing: FeedLanding = { version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "org-news",
    source: { kind: "git", repo: "https://never-fetch.invalid/source" }, revision, tree: `trees/${revision}`, commit: past, ref: "main", paths: ["published"], switching_at: EARLY, landed_at: EARLY };
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
      await log([{ ...landing, commit, revision, tree: `trees/${revision}`, switching_at: EARLY, landed_at: EARLY }]);
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
    const selected = { ...landing, landed_at: AT };
    await log([selected, { ...landing, revision: "f".repeat(64), tree: `trees/${"f".repeat(64)}`, landed_at: "2026-10-09T08:20:31.001Z" }]);
    context.record = { ...testMomentRecord(), feeds: [{ id: "news", revision, tree: `trees/${revision}`, commit: landing.commit!, ref: "main", paths: ["published"], landedAt: "2026-10-09T10:20:31+02:00" }] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { commit: landing.commit, revision }, instant: "2026-10-09T10:20:31+02:00" });
    expect(await readlink(path.join(context.destination, "current"))).toBe(`trees/${revision}`);
    expect(await readFile(path.join(context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
    const identity = JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8"));
    expect(feedIdentityFindings(identity)).toEqual([]);
    expect(identity).toMatchObject({ landed_at: "2026-10-09T10:20:31+02:00", files: 1, source: { commit: landing.commit, paths: ["published"], ref: "main" } });
  });

  it("uses a present pin from an inexact record without a landing log or optional ref", async () => {
    const { context, landing } = await fixture();
    context.record = { ...testMomentRecord(), exact: false, errors: ["memory self unavailable"],
      feeds: [{ id: "news", revision: landing.revision, tree: landing.tree, commit: landing.commit,
        paths: landing.paths, landedAt: EARLY }] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { commit: landing.commit } });
    expect(await readFile(path.join(context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
    expect(JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8")).source.ref).toBe(landing.commit);
  });

  it("keeps the original wake pin when another landing precedes the replay", async () => {
    const { context, landing, log, repository } = await fixture();
    const commit = await commitTestGit(repository, { "published/news.txt": "later landing\n" }, "2026-10-09T08:10:00Z");
    const revision = resolveFeedSource({ kind: "git", fetch: false, repo: repository, ref: commit, paths: ["published"] }).revision;
    await log([landing, { ...landing, commit, revision, tree: `trees/${revision}`, landed_at: "2026-10-09T08:11:00Z" }]);
    context.record = { ...testMomentRecord(), feeds: [{ id: "news", revision: landing.revision, tree: landing.tree,
      commit: landing.commit, ref: landing.ref, paths: landing.paths, landedAt: EARLY }] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { commit: landing.commit } });
    expect(await readFile(path.join(context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
  });

  it.each(["2026-10-09T08:20:30Z", AT, "2026-10-09T08:20:32Z"])
    ("uses the incoming transition landing approximately at %s", async (at) => {
      const { context, landing, log } = await fixture();
      const incoming = { ...landing, switching_at: "2026-10-09T08:20:30Z", landed_at: "2026-10-09T08:20:32Z" };
      await log([landing, incoming]); context.at = at;
      const result = await materializeFeed(context);
      expect(result).toMatchObject({ fidelity: "approximate", basis: "landing-log", instant: at,
        source: { switchingAt: incoming.switching_at, landedAt: incoming.landed_at } });
      expect(result.notes).toEqual([expect.stringContaining("ambiguous feed transition")]);
      expect(JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8")).landed_at).toBe(incoming.landed_at);
      expect(await readFile(path.join(context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
    });

  it("falls back to the feed rule at the trial instant with historical committer landing time", async () => {
    const { context, past, revision } = await fixture();
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "approximate", basis: "feed-rule-at", source: { commit: past, revision }, instant: "2026-10-09T08:00:00.000Z" });
    const identity = JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8"));
    expect(Date.parse(identity.landed_at)).toBeLessThanOrEqual(Date.parse(AT));
    expect(await readdir(path.join(context.destination, "current"))).toEqual(["published"]);
  });

  it("steps back past a future-authored feed commit", async () => {
    const { context, resource, repository, past } = await fixture();
    testGit(repository, ["checkout", "--detach", past]);
    await commitTestGit(repository, { "published/news.txt": "future-authored\n" }, "2026-10-09T08:10:00Z");
    testGit(repository, ["commit", "--amend", "--no-edit", `--date=${LATE}`], "2026-10-09T08:10:00Z");
    resource.feed!.git!.ref = "HEAD";
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "approximate", basis: "feed-rule-at", source: { commit: past } });
    expect(await readFile(path.join(context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
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
    const prepared = { include: [], prepare: { command: ["never-run-prepare"], image: null, network: null, platform: null }, source_revision: landing.revision };
    const revision = createHash("sha256").update(`prepared\n${JSON.stringify(prepared)}\n`).digest("hex");
    const retained = path.join(directory, "trees", `${revision}.2`);
    await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "prepared.txt"), "retained\n");
    await log([{ ...landing, revision, tree: `trees/${revision}.2`, source: { kind: "git", repo: "never-used", prepared } }]);
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "approximate", basis: "landing-log",
      notes: ["prepared output not content-verifiable"] });
    expect(await readlink(path.join(context.destination, "current"))).toBe(`trees/${revision}.2`);
    expect(await readFile(path.join(context.destination, "current/prepared.txt"), "utf8")).toBe("retained\n");
    expect(JSON.parse(await readFile(path.join(context.destination, ".spawnfile-feed.json"), "utf8")).source.prepared.prepare.command).toEqual(["never-run-prepare"]);
  });

  it.each(["unchanged", "changed bytes", "extra file", "missing file", "wrong revision", "missing repository"])
    ("verifies retained plain git feed with %s against commit and paths", async (change) => {
      const f = await fixture();
      const revision = change === "wrong revision" ? "0".repeat(64) : f.revision;
      const retained = path.join(f.directory, "trees", revision);
      await mkdir(path.join(retained, "published"), { recursive: true });
      if (change !== "missing file") await writeFile(path.join(retained, "published/news.txt"), change === "changed bytes" ? "future\n" : "past\n");
      if (change === "extra file") await writeFile(path.join(retained, "extra.txt"), "future\n");
      await f.log([{ ...f.landing, revision, tree: `trees/${revision}` }]);
      if (change === "missing repository") await rm(f.repository, { recursive: true });
      if (change === "unchanged") {
        expect(await materializeFeed(f.context)).toMatchObject({ fidelity: "exact" });
        expect(await readFile(path.join(f.context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
        expect(await readdir(f.context.destination)).not.toContain(".retained-check");
      } else await expect(materializeFeed(f.context)).rejects.toThrow(change === "wrong revision" ? "Feed revision mismatch"
        : change === "missing repository" ? "Missing feed source repository" : "Retained git feed bytes disagree with selected commit and paths");
    });

  it("uses retained directory feed landings and starts overridden feeds empty", async () => {
    const { context, resource, directory, log } = await fixture();
    resource.feed = { directory: "never-read" };
    const retainedTemp = path.join(directory, "retained"); await mkdir(retainedTemp); await writeFile(path.join(retainedTemp, "data.txt"), "directory\n");
    const revision = digestDirectory(retainedTemp), retained = path.join(directory, "trees", revision);
    await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "data.txt"), "directory\n");
    await log([{ version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "org-news",
      source: { kind: "directory", directory: "never-read" }, revision, tree: `trees/${revision}`, switching_at: EARLY, landed_at: EARLY }]);
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", source: { revision } });
    expect(await readFile(path.join(context.destination, "current/data.txt"), "utf8")).toBe("directory\n");
    await rm(context.destination, { recursive: true }); context.input.overridden = true; context.history = undefined;
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "overridden", basis: "override" });
    expect(await readdir(context.destination)).toEqual([]);
  });

  it("uses retained directory record pins without optional git metadata or a log", async () => {
    const { context, resource, directory } = await fixture();
    resource.feed = { directory: "never-read" };
    const retained = path.join(directory, "retained"); await mkdir(retained); await writeFile(path.join(retained, "data.txt"), "past\n");
    const revision = digestDirectory(retained), selected = path.join(directory, "trees", `${revision}.2`);
    await mkdir(selected, { recursive: true }); await writeFile(path.join(selected, "data.txt"), "past\n");
    context.record = { ...testMomentRecord(), feeds: [{ id: "news", revision, tree: `trees/${revision}.2`, landedAt: EARLY }] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { revision } });
    expect(await readFile(path.join(context.destination, "current/data.txt"), "utf8")).toBe("past\n");
  });

  it.each(["changed bytes", "extra file", "missing file"])("refuses retained directory feeds with %s", async (change) => {
    const { context, directory, landing, log } = await fixture();
    const retained = path.join(directory, "retained"); await mkdir(retained); await writeFile(path.join(retained, "data.txt"), "past\n");
    const revision = digestDirectory(retained), selected = path.join(directory, "trees", `${revision}.3`);
    await mkdir(selected, { recursive: true });
    if (change !== "missing file") await writeFile(path.join(selected, "data.txt"), change === "changed bytes" ? "evil\n" : "past\n");
    if (change === "extra file") await writeFile(path.join(selected, "extra.txt"), "extra\n");
    // Historical source kind controls verification even after the declaration switched to git.
    const { commit: _commit, ref: _ref, paths: _paths, ...base } = landing;
    await log([{ ...base, source: { kind: "directory", directory: "never-read" }, revision, tree: `trees/${revision}.3` }]);
    await expect(materializeFeed(context)).rejects.toThrow("Directory feed revision mismatch");
  });

  it("does not substitute another retained generation for a missing directory tree", async () => {
    const { context, directory, landing, log } = await fixture();
    const retained = path.join(directory, "retained"); await mkdir(retained); await writeFile(path.join(retained, "data.txt"), "past\n");
    const revision = digestDirectory(retained), previous = path.join(directory, "trees", revision);
    await mkdir(previous, { recursive: true }); await writeFile(path.join(previous, "data.txt"), "past\n");
    const { commit: _commit, ref: _ref, paths: _paths, ...base } = landing;
    await log([{ ...base, source: { kind: "directory", directory: "never-read" }, revision, tree: `trees/${revision}.3` }]);
    await expect(materializeFeed(context)).rejects.toThrow("Directory/prepared/included feed requires retained landed tree bytes");
  });

  it("refuses revisions which cannot be reproduced from the selected commit", async () => {
    const { context, landing, log } = await fixture();
    await log([{ ...landing, revision: "0".repeat(64), tree: `trees/${"0".repeat(64)}` }]);
    await expect(materializeFeed(context)).rejects.toThrow("Feed revision mismatch");
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
    const prepared = { include: [], prepare: { command: ["never-execute"], image: null, network: null, platform: null }, source_revision: landing.revision };
    const revision = createHash("sha256").update(`prepared\n${JSON.stringify(prepared)}\n`).digest("hex");
    await log([{ ...landing, revision, tree: `trees/${revision}`, source: { kind: "git", repo: "never-read", prepared } }]);
    await expect(materializeFeed(context)).rejects.toThrow("retained landed tree bytes");
    context.history = undefined;
    await expect(materializeFeed(context)).rejects.toThrow("--history is required");
  });

  it("refuses before the first landing in a nonempty log unless overridden", async () => {
    const { context, landing, log } = await fixture();
    await log([{ ...landing, switching_at: LATE, landed_at: LATE }]);
    await expect(materializeFeed(context)).rejects.toThrow(`Feed news has no landed state at ${AT}; provide an override`);
    await expect(readdir(context.destination)).rejects.toThrow();
    context.input.overridden = true;
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "overridden", basis: "override" });
    expect(await readdir(context.destination)).toEqual([]);
  });

  it("preserves a matching wake pin before the first retained landing", async () => {
    const { context, landing, log } = await fixture();
    await log([{ ...landing, switching_at: LATE, landed_at: LATE }]);
    context.record = { ...testMomentRecord(), feeds: [{ id: "news", revision: landing.revision, tree: landing.tree,
      commit: landing.commit, ref: landing.ref, paths: landing.paths, landedAt: EARLY }] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { commit: landing.commit } });
    expect(await readFile(path.join(context.destination, "current/published/news.txt"), "utf8")).toBe("past\n");
  });

  it("validates every landing line and falls back for an empty landing log", async () => {
    const { context, directory, landing } = await fixture();
    await writeFile(path.join(directory, "landings.jsonl"), `${JSON.stringify(landing)}\n${JSON.stringify({ ...landing, switching_at: undefined })}\n`);
    await expect(materializeFeed(context)).rejects.toThrow(/landings.jsonl:2/u);
    await writeFile(path.join(directory, "landings.jsonl"), "");
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "approximate", basis: "feed-rule-at" });
    await rm(context.destination, { recursive: true });
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

});
