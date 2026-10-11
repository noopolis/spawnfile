import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { momentRecordSchema } from "./contract.js";
import { feedLandingSchema, materializeFeed } from "./feed.js";
import { materializeGit } from "./git.js";
import { commitTestGit, gitTestRoot, initTestGit, testGit, testMomentRecord } from "./git.test-helper.js";
import { History } from "./history.js";
import { resolveRecordedCommit } from "./recordedCommit.js";
import type { InputContext } from "./types.js";
import { resolveFeedSource } from "../../../volume/index.js";

const AT = "2026-10-09T08:20:31Z", EARLY = "2026-10-09T08:00:00Z", REVISION = "e".repeat(64);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const landing = (commit: string) => ({ version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "org-news", source: { kind: "git", repo: "recorded-repo" }, revision: REVISION, tree: REVISION, commit, ref: "main", paths: [], landed_at: EARLY });
const feedRecord = (commit: string, revision = REVISION) => ({ id: "news", revision, tree: revision, commit, paths: [], landedAt: EARLY });
const recordedValue = (field: "resources" | "feeds" | "landing", commit: string): string | undefined => {
  if (field === "landing") return feedLandingSchema.parse(landing(commit)).commit;
  const value = momentRecordSchema.parse({ ...testMomentRecord(), [field]: field === "resources"
    ? [{ id: "archive", kind: "git", commit }]
    : [{ id: "news", revision: REVISION, tree: REVISION, commit, paths: [], landedAt: EARLY }] });
  const entry = value[field][0]!;
  return "commit" in entry ? entry.commit : undefined;
};
const fixture = async () => {
  const root = await gitTestRoot(); roots.push(root);
  const repository = path.join(root, "history/git/agent%3Awriter/archive");
  await initTestGit(repository);
  const past = await commitTestGit(repository, { "readme.txt": "recorded bytes\n" }, EARLY);
  testGit(repository, ["tag", "--annotate", "record-tag", "--message", "not a commit object", past]);
  const objects = { blob: testGit(repository, ["rev-parse", `${past}:readme.txt`]),
    tree: testGit(repository, ["rev-parse", `${past}^{tree}`]), tag: testGit(repository, ["rev-parse", "refs/tags/record-tag"]) };
  const context: InputContext = { at: AT, destination: path.join(root, "output"), history: new History(path.join(root, "history")),
    record: { ...testMomentRecord(), resources: [{ id: "archive", kind: "git", commit: past }] },
    input: { section: "resources", declaredBy: "agent:writer", id: "archive", declarationBase: root, overridden: false,
      declaration: { id: "archive", kind: "git", mode: "readonly", mount: "./archive", url: repository } } };
  return { root, repository, past, objects, context };
};
const retainedFeed = async () => {
  const source = await fixture();
  const directory = path.join(source.root, "history/feeds/agent%3Awriter/news"), repository = path.join(directory, "repo");
  await mkdir(directory, { recursive: true });
  testGit(source.root, ["clone", "--quiet", "--bare", source.repository, repository]);
  const revision = resolveFeedSource({ kind: "git", repo: repository, ref: source.past, fetch: false }).revision;
  const retained = path.join(directory, "trees", revision);
  await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "readme.txt"), "recorded bytes\n");
  const context: InputContext = { at: AT, destination: path.join(source.root, "feed-output"), history: source.context.history, record: null,
    input: { section: "resources", declaredBy: "agent:writer", id: "news", declarationBase: source.root, overridden: false,
      declaration: { id: "news", kind: "volume", mode: "mutable", mount: "./news", name: "org-news",
        feed: { git: { repo: "never-fetch" }, prepare: { host: true, command: ["never-run"] } } } } };
  const log = async (commit: string) => writeFile(path.join(directory, "landings.jsonl"), `${JSON.stringify({ ...landing(commit), revision, tree: revision })}\n`);
  return { ...source, repository, directory, context, log, revision };
};

describe("recorded commit contracts", () => {
  it.each(["resources", "feeds", "landing"] as const)("normalizes full SHA-1 and SHA-256 %s commits to lowercase", (field) => {
    for (const length of [40, 64]) expect(recordedValue(field, "AbCDef12".repeat(length / 8))).toBe("abcdef12".repeat(length / 8));
  });

  it.each(["resources", "feeds", "landing"] as const)("rejects moving selectors, abbreviated and malformed %s commit IDs", (field) => {
    for (const value of ["HEAD", "main", "refs/tags/old", "abcdef1", "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "g".repeat(40)]) {
      expect(() => recordedValue(field, value), `${field}: ${value}`).toThrow("Expected a full 40- or 64-hex commit object id");
    }
  });

  it("directory landing logs omit git commit fields", () => {
    const { commit: _commit, ref: _ref, paths: _paths, ...entry } = landing("a".repeat(40));
    expect(feedLandingSchema.parse({ ...entry, source: { kind: "directory", directory: "/source" } }).commit).toBeUndefined();
  });
});

describe("recorded git commit objects", () => {
  const kind = "git" as const;
  it("materializes the full recorded ID case-insensitively", async () => {
    const { past, context } = await fixture();
    context.record!.resources[0] = { id: "archive", kind: "git", commit: past.toUpperCase() };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { commit: past } });
    expect(await readFile(path.join(context.destination, "readme.txt"), "utf8")).toBe("recorded bytes\n");
  });

  it.each(["blob", "tree", "tag"] as const)("refuses a recorded %s object without peeling it", async (type) => {
    const { objects, context } = await fixture();
    context.record!.resources[0] = { id: "archive", kind: "git", commit: objects[type] };
    await expect(materializeGit(context)).rejects.toThrow(`Recorded object ${objects[type]} must be a commit object; found ${type}`);
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it("refuses moving and abbreviated records even when their selectors resolve", async () => {
    const { past, context } = await fixture();
    for (const commit of ["HEAD", past.slice(0, 12)]) {
      context.record!.resources[0] = { id: "archive", kind: "git", commit };
      await expect(materializeGit(context)).rejects.toThrow("Expected a full 40- or 64-hex commit object id");
    }
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  const pin = (context: InputContext, commit: string) => {
    if (context.input.section !== "resources" || context.input.declaration.kind === "volume") throw new Error("Expected git-backed resource");
    context.input.declaration = kind === "git" ? { ...context.input.declaration, kind, url: "never-read", ref: commit }
      : { id: "archive", kind, mode: "readonly", mount: "./archive", build: { files: { root: ".", ref: commit } } };
  };

  it.each(["blob", "tree", "tag"] as const)("refuses a matching %s record despite a valid declared pin", async (type) => {
    const { context, past, objects } = await fixture();
    pin(context, past); context.record!.resources[0] = { id: "archive", kind: "git", commit: objects[type] };
    await expect(materializeGit(context)).rejects.toThrow(`Recorded object ${objects[type]} must be a commit object; found ${type}`);
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it("keeps pin precedence after verifying a different valid recorded commit", async () => {
    const { context, repository, past } = await fixture();
    const next = await commitTestGit(repository, { "readme.txt": "other recorded commit\n" }, "2026-10-09T08:10:00Z");
    pin(context, past); context.record!.resources[0] = { id: "archive", kind: "git", commit: next.toUpperCase() };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact", basis: "pinned", source: { commit: past } });
    expect(await readFile(path.join(context.destination, "readme.txt"), "utf8")).toBe("recorded bytes\n");
  });

  it("does not verify unrelated recorded inputs", async () => {
    const { context, past, objects } = await fixture();
    pin(context, past); context.record!.resources[0] = { id: "other", kind, commit: objects.blob };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact", basis: "pinned", source: { commit: past } });
  });
});

describe("recorded commit validation authority", () => {
  it("requires history for a matching pin record even if the local declared repository has the commit", async () => {
    const { context, repository, past } = await fixture();
    context.history = undefined;
    context.input.declaration = { id: "archive", kind: "git", mode: "readonly", mount: "./archive", url: repository, ref: past };
    await expect(materializeGit(context)).rejects.toThrow("Missing git history for recorded resource archive");
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it("does not verify the replaced input's recorded commit for an override", async () => {
    const { context, repository, past, objects } = await fixture();
    context.input.overridden = true; context.history = undefined; context.record!.resources[0] = { id: "archive", kind: "git", commit: objects.blob };
    context.candidateRecords = [context.record!];
    context.input.declaration = { id: "archive", kind: "git", mode: "readonly", mount: "./archive", url: repository, ref: past };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "overridden", source: { commit: past } });
  });
});

describe("retained feed recorded commit objects", () => {
  it("normalizes landing and moment IDs before comparing and reports the commit object", async () => {
    const { context, past, log, revision } = await retainedFeed();
    await log(past.toUpperCase());
    context.record = { ...testMomentRecord(), feeds: [feedRecord(past.toUpperCase(), revision)] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", source: { commit: past } });
    expect(await readFile(path.join(context.destination, "current/readme.txt"), "utf8")).toBe("recorded bytes\n");
  });

  it.each(["blob", "tree", "tag"] as const)("refuses a retained tree whose recorded commit is a %s", async (type) => {
    const { context, objects, log } = await retainedFeed();
    await log(objects[type]);
    await expect(materializeFeed(context)).rejects.toThrow(`Recorded object ${objects[type]} must be a commit object; found ${type}`);
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it("refuses retained bytes when a recorded commit is absent from its history repository", async () => {
    const { context, log } = await retainedFeed();
    await log("0".repeat(40));
    await expect(materializeFeed(context)).rejects.toThrow("Rewind git cat-file failed");
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it("requires the history repository even when retained tree bytes exist", async () => {
    const { context, past, repository, log } = await retainedFeed();
    await log(past); await rm(repository, { recursive: true });
    await expect(materializeFeed(context)).rejects.toThrow("Missing feed source repository for news");
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it.each(["blob", "tree", "tag"] as const)("validates an unselected landing's %s commit object", async (type) => {
    const { context, past, objects, directory } = await retainedFeed();
    const entries = [landing(past), { ...landing(objects[type]), landed_at: "2026-10-09T09:00:00Z" }];
    await writeFile(path.join(directory, "landings.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await expect(materializeFeed(context)).rejects.toThrow(`Recorded object ${objects[type]} must be a commit object; found ${type}`);
    await expect(readdir(context.destination)).rejects.toThrow();
  });
});

describe("feed moment records without landing logs", () => {
  const fallbackFeed = async () => {
    const value = await retainedFeed(), input = value.context.input;
    if (input.section !== "resources" || input.declaration.kind !== "volume") throw new Error("Expected volume feed");
    input.declaration.feed = { git: { repo: "never-fetch", ref: "main" } };
    return value;
  };

  it.each(["blob", "tree", "tag"] as const)("refuses matching %s moment commits before feed-rule fallback", async (type) => {
    const { context, objects } = await fallbackFeed();
    context.record = { ...testMomentRecord(), feeds: [feedRecord(objects[type])] };
    await expect(materializeFeed(context)).rejects.toThrow(`Recorded object ${objects[type]} must be a commit object; found ${type}`);
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it("uses a verified moment commit without a landing log", async () => {
    const { context, past, revision } = await fallbackFeed();
    context.record = { ...testMomentRecord(), feeds: [feedRecord(past.toUpperCase(), revision)] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { commit: past } });
  });

  it("does not verify unrelated feed moment records", async () => {
    const { context, objects, past } = await fallbackFeed();
    context.record = { ...testMomentRecord(), feeds: [{ ...feedRecord(objects.blob), id: "other" }] };
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "approximate", source: { commit: past } });
  });

  it("does not verify the replaced feed's moment record for an override", async () => {
    const { context, objects } = await fallbackFeed();
    context.input.overridden = true; context.history = undefined;
    context.record = { ...testMomentRecord(), feeds: [feedRecord(objects.blob)] };
    context.candidateRecords = [context.record];
    expect(await materializeFeed(context)).toMatchObject({ fidelity: "overridden", basis: "override", source: {} });
  });
});

describe("recorded commit object format", () => {
  it("verifies full SHA-256 commit IDs without changing object format", async () => {
    const root = await gitTestRoot(); roots.push(root);
    testGit(root, ["init", "--quiet", "--initial-branch=main", "--template=", "--object-format=sha256"]);
    const commit = await commitTestGit(root, { "readme.txt": "SHA-256\n" }, EARLY);
    expect(commit).toHaveLength(64);
    expect(await resolveRecordedCommit(root, commit.toUpperCase())).toBe(commit);
  });
});
