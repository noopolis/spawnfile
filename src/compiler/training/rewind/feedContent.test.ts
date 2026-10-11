import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestDirectory, hostExec } from "../../../volume/index.js";
import { resolveFeedContent } from "../../../volume/feedPrepare.js";
import { cleanTrainingProjects } from "../plan/fixtures.test-helper.js";
import * as feed from "./feed.js";
import { AT, BEFORE, emptyRecord, jsonl, rewindFixture } from "./fixtures.test-helper.js";
import { leakCheckTrainingMoment } from "./leakCheck.js";
import { materializeTrainingMoment, resolveTrainingMoment } from "./materialize.js";
import { stampTree } from "./timestamps.js";

afterEach(cleanTrainingProjects);
afterEach(() => vi.restoreAllMocks());

const preparedFixture = async (kind: "git" | "directory", recipe: "include" | "prepare", recordOnly = false) => {
  const f = await rewindFixture(), directory = path.dirname(f.feedRepo), sourceDirectory = path.join(f.root, "source");
  await mkdir(sourceDirectory); await writeFile(path.join(sourceDirectory, "source.txt"), "source bytes\n");
  const resolved = resolveFeedContent({ resourceId: "news", volume: directory, volumeName: "news", stateDir: directory, keep: 1, healLimit: 3,
    source: kind === "git" ? { kind, repo: f.feedRepo, ref: f.commit, fetch: false } : { kind, directory: sourceDirectory },
    ...(recipe === "include" ? { include: [] } : { prepare: { kind: "host" as const, command: ["never-run-recipe"], timeoutMs: 1 } })
  }, { exec: hostExec });
  const retained = path.join(directory, "trees", resolved.revision);
  await mkdir(retained, { recursive: true }); await writeFile(path.join(retained, "prepared.txt"), "landed prepared bytes\n");
  expect(digestDirectory(retained)).not.toBe(resolved.revision);
  const log = "feeds/team%3Apublication/news/landings.jsonl";
  await jsonl(f.historyDir, log, [{ version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "news",
    revision: resolved.revision, tree: `trees/${resolved.revision}`, landed_at: BEFORE,
    source: { kind, ...(kind === "git" ? { repo: f.feedRepo } : { directory: sourceDirectory }), prepared: resolved.provenance.prepared },
    ...(kind === "git" ? { commit: f.commit, ref: "main" } : {}) }]);
  if (recordOnly) {
    const input = resolveTrainingMoment(f.plan, f.project, f.options.example).inputs.find((entry) => entry.id === "news" && entry.section === "resources")!;
    if (input.section !== "resources" || input.declaration.kind !== "volume") throw new Error("Expected feed");
    input.declaration.feed = { ...(kind === "git" ? { git: { repo: f.feedRepo } } : { directory: sourceDirectory }), include: [] };
    const record = emptyRecord(); record.feeds = [{ id: "news", revision: resolved.revision, tree: `trees/${resolved.revision}`, landedAt: BEFORE,
      ...(kind === "git" ? { commit: f.commit, ref: "main" } : {}) }];
    await jsonl(f.historyDir, "moments/prepared.jsonl", [record]); await rm(path.join(f.historyDir, log));
  }
  return f;
};

describe("independent feed byte verification", () => {
  it.each(["changed bytes", "extra file", "wrong revision", "missing repository"])
    ("rejects a broken plain git producer with %s at acceptance", async (change) => {
      const f = await rewindFixture(), correct = feed.materializeFeed;
      vi.spyOn(feed, "materializeFeed").mockImplementation(async (context) => {
        const result = await correct(context);
        if (change === "missing repository") await rm(f.feedRepo, { recursive: true });
        else if (change === "wrong revision") {
          const file = path.join(context.destination, ".spawnfile-feed.json"), identity = JSON.parse(await readFile(file, "utf8"));
          identity.revision = "0".repeat(64); result.source.revision = identity.revision;
          await writeFile(file, JSON.stringify(identity));
        } else await writeFile(path.join(context.destination, "current", change === "changed bytes" ? "news.txt" : "extra.txt"), "future bytes\n");
        return result;
      });
      const result = await materializeTrainingMoment(f.options);
      expect(result.status).toBe("refused");
      const check = JSON.parse(await readFile(path.join(f.options.out, "leak-check.json"), "utf8"));
      expect(check.findings).toContainEqual(expect.objectContaining({ class: "feed-identity", path: "resources/team%3Apublication/news",
        detail: change === "missing repository" ? "Missing feed source history repository for content verification"
          : change === "wrong revision" ? "Feed revision disagrees with selected commit and paths" : "Git feed bytes disagree with selected commit and paths" }));
      expect(check.findings.some((finding: { class: string }) => finding.class === "file-time")).toBe(false);
      expect(await readdir(f.options.out)).toEqual(["leak-check.json", "moment.json"]);
    });

  it.each((["git", "directory"] as const).flatMap((kind) => (["include", "prepare"] as const).map((recipe) => ({ kind, recipe }))))
    ("accepts recording-format $kind/$recipe provenance with approximate prepared bytes", async ({ kind, recipe }) => {
      const f = await preparedFixture(kind, recipe), result = await materializeTrainingMoment(f.options);
      expect(result, JSON.stringify(result.inputs)).toMatchObject({ status: "materialized", leakCheck: { ok: true } });
      const input = result.inputs.find((entry) => entry.kind === "feed")!;
      expect(input).toMatchObject({ fidelity: "approximate", source: { prepared: true }, notes: ["prepared output not content-verifiable"] });
      expect(await readFile(path.join(f.options.out, input.path!, "current/prepared.txt"), "utf8")).toBe("landed prepared bytes\n");
      await stampTree(f.options.out, BEFORE, AT);
      expect((await leakCheckTrainingMoment(f.options.out, { historyDir: f.historyDir })).findings).toEqual([]);
      result.inputs.find((entry) => entry.kind === "feed")!.fidelity = "exact";
      await writeFile(path.join(f.options.out, "moment.json"), JSON.stringify(result)); await stampTree(f.options.out, BEFORE, AT);
      expect((await leakCheckTrainingMoment(f.options.out, { historyDir: f.historyDir })).findings)
        .toContainEqual(expect.objectContaining({ class: "feed-identity", detail: "Prepared feed must be approximate: prepared output not content-verifiable" }));
    });

  it.each(["git", "directory"] as const)("keeps record-only prepared %s bytes approximate when the landing log is absent", async (kind) => {
    const f = await preparedFixture(kind, "include", true), result = await materializeTrainingMoment(f.options);
    expect(result, JSON.stringify(result.inputs)).toMatchObject({ status: "materialized", leakCheck: { ok: true } });
    expect(result.inputs.find((entry) => entry.kind === "feed")).toMatchObject({ fidelity: "approximate", basis: "record",
      source: { prepared: true }, notes: ["prepared output not content-verifiable"] });
  });

  it("still applies filesystem leak classes to prepared output", async () => {
    const f = await preparedFixture("directory", "prepare"), result = await materializeTrainingMoment(f.options);
    expect(result.status).toBe("materialized");
    const tree = path.join(f.options.out, result.inputs.find((entry) => entry.kind === "feed")!.path!, "current");
    await mkdir(path.join(tree, ".git")); await writeFile(path.join(tree, "2099-01-01.txt"), "future path");
    await symlink("/outside", path.join(tree, "escape")); await stampTree(f.options.out, BEFORE, AT);
    await writeFile(path.join(tree, "prepared.txt"), "changed now");
    const check = await leakCheckTrainingMoment(f.options.out, { historyDir: f.historyDir });
    for (const kind of ["file-time", "git-object", "dated-path", "symlink-escape"]) expect(check.findings)
      .toContainEqual(expect.objectContaining({ class: kind, path: expect.stringContaining("resources/team%3Apublication/news/trees/") }));
  });
});
