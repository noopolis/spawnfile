import { cp, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTrainingProject, resolveTrainingPlan } from "../plan/index.js";
import { agentManifest, cleanTrainingProjects, dataFiles, example, trainingProject } from "../plan/fixtures.test-helper.js";
import { materializeTrainingMoment, resolveTrainingMoment } from "./materialize.js";
import { leakCheckTrainingMoment } from "./leakCheck.js";
import * as gitMaterializer from "./git.js";
import * as volumeMaterializer from "./volumes.js";
import { AT, BEFORE, FUTURE, emptyRecord, jsonl, rewindFixture, testGit } from "./fixtures.test-helper.js";

afterEach(cleanTrainingProjects);
afterEach(() => vi.restoreAllMocks());

describe("materializeTrainingMoment", () => {
  it("stages every effective input, verifies disk, and preserves source times", async () => {
    const fixture = await rewindFixture();
    const resolved = resolveTrainingMoment(fixture.plan, fixture.project, example.id);
    expect(resolved.inputs.map((input) => `${input.section}:${input.id}`)).toEqual([
      "memory:self", "networks:news", "resources:code", "resources:edition-state", "resources:news"
    ]);
    const result = await materializeTrainingMoment(fixture.options);
    expect(result.status).toBe("materialized");
    expect(result.leakCheck).toEqual({ ok: true, findings: 0 });
    expect(result.inputs.map((input) => input.fidelity)).toEqual(["approximate", "overridden", "approximate", "approximate", "exact"]);
    const inspectTimes = async (file: string): Promise<void> => {
      const stats = await lstat(file);
      expect(stats.mtimeMs, file).toBeLessThanOrEqual(Date.parse(AT));
      expect(stats.atimeMs, file).toBeLessThanOrEqual(Date.parse(AT));
      if (stats.isDirectory()) for (const name of await readdir(file)) await inspectTimes(path.join(file, name));
    };
    expect((await leakCheckTrainingMoment(fixture.options.out, { historyDir: fixture.historyDir })).ok).toBe(true);
    await inspectTimes(fixture.options.out);
    for (const input of result.inputs.filter((item) => item.kind !== "moltnet")) {
      expect((await lstat(path.join(fixture.options.out, input.path!))).mtime.toISOString()).toBe(new Date(BEFORE).toISOString());
    }
    expect((await readdir(fixture.root)).filter((name) => name.includes(".rewind-"))).toEqual([]);
    expect(await readFile(path.join(fixture.gitRepo, "future.txt"), "utf8")).toContain("after wake");
  });
  it("uses equal-instant records and accepts an existing empty output directory", async () => {
    const fixture = await rewindFixture();
    await mkdir(fixture.options.out);
    const record = { ...emptyRecord("agent:a", "2026-10-09T10:20:31+02:00"),
      resources: [{ id: "code", kind: "git", commit: fixture.commit }],
      memory: [{ id: "self", declaredBy: "agent:a", seq: 1 }],
      volumes: [{ id: "edition-state", snapshot: "20261009T070000000Z-execution-17" }] };
    await jsonl(fixture.historyDir, "moments/anything.jsonl", [record]);
    const result = await materializeTrainingMoment(fixture.options);
    expect(result.status).toBe("materialized");
    expect(result.record.matched).toBe(true);
    expect(result.inputs.filter((input) => input.fidelity === "approximate")).toEqual([]);
  });
  it("refuses a suppressed candidate's noncommit only for its pinned input", async () => {
    const fixture = await rewindFixture();
    const code = resolveTrainingMoment(fixture.plan, fixture.project, example.id).inputs.find((input) => input.id === "code")!;
    if (code.section !== "resources" || code.declaration.kind !== "git") throw new Error("Expected git resource");
    code.declaration.ref = fixture.commit; delete code.declaration.branch;
    const blob = testGit(fixture.gitRepo, ["rev-parse", `${fixture.commit}:news.txt`]);
    const first = { ...emptyRecord(), resources: [{ id: "code", kind: "git", commit: fixture.commit }] };
    await jsonl(fixture.historyDir, "moments/candidates.jsonl", [first,
      { ...first, resources: [{ id: "code", kind: "git", commit: blob }] }]);
    let snapshotBeforeDiscard = "";
    const correct = volumeMaterializer.materializeVolume;
    vi.spyOn(volumeMaterializer, "materializeVolume").mockImplementation(async (context) => {
      const result = await correct(context);
      snapshotBeforeDiscard = await readFile(path.join(context.destination, "saved.txt"), "utf8");
      return result;
    });
    const result = await materializeTrainingMoment(fixture.options);
    expect(result.status).toBe("refused");
    expect(result.inputs.find((input) => input.id === "code")!.refusal)
      .toBe(`Recorded object ${blob} must be a commit object; found blob`);
    expect(result.inputs.filter((input) => input.refusal !== null).map((input) => input.id)).toEqual(["code"]);
    expect(result.inputs.find((input) => input.id === "edition-state"))
      .toMatchObject({ fidelity: "approximate", source: { snapshot: "20261009T070000000Z-execution-17" }, refusal: null });
    expect(snapshotBeforeDiscard).toBe("snapshot bytes\n");
    expect(await readdir(fixture.options.out)).toEqual(["moment.json"]);
  });
  it("excludes other agents, other wakes, and unrelated inputs from candidate commit validation", async () => {
    const fixture = await rewindFixture();
    const code = resolveTrainingMoment(fixture.plan, fixture.project, example.id).inputs.find((input) => input.id === "code")!;
    if (code.section !== "resources" || code.declaration.kind !== "git") throw new Error("Expected git resource");
    code.declaration.ref = fixture.commit; delete code.declaration.branch;
    const blob = testGit(fixture.gitRepo, ["rev-parse", `${fixture.commit}:news.txt`]);
    const first = { ...emptyRecord(), resources: [{ id: "code", kind: "git", commit: fixture.commit }] };
    await jsonl(fixture.historyDir, "moments/candidates.jsonl", [first,
      { ...emptyRecord("agent:other"), resources: [{ id: "code", kind: "git", commit: blob }] },
      { ...emptyRecord("agent:a", FUTURE), resources: [{ id: "code", kind: "git", commit: blob }] },
      { ...first, resources: [...first.resources, { id: "unrelated", kind: "git", commit: blob }] }]);
    expect((await materializeTrainingMoment(fixture.options)).status).toBe("materialized");
  });
  it("collects all missing-history refusals and leaves only moment.json", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      memory: [{ id: "self", store: { kind: "memory" } }],
      workspace: { docs: { system: "AGENTS.md" }, resources: [
        { id: "code", kind: "git", mode: "readonly", mount: "./code", url: "https://invalid.example/code.git" },
        { id: "prebuilt", kind: "bundle", mode: "readonly", mount: "./prebuilt", source: "archive.tar" },
        { id: "news", kind: "volume", name: "news", mode: "mutable", mount: "./news", feed: { directory: "." } }
      ] }
    }) });
    const project = await loadTrainingProject(root), plan = resolveTrainingPlan(project, "agent:writer", "test");
    const out = path.join(root, "out"), result = await materializeTrainingMoment({ project, plan, example: example.id, out });
    expect(result.status).toBe("refused");
    expect(result.inputs).toHaveLength(4);
    expect(result.inputs.every((input) => input.refusal && input.path === null)).toBe(true);
    expect(result.inputs.map((input) => input.refusal).join(" ")).toMatch(/Prebuilt bundle/);
    expect(await readdir(out)).toEqual(["moment.json"]);
    expect((await readdir(root)).filter((name) => name.includes(".rewind-"))).toEqual([]);
    const missing = await materializeTrainingMoment({ project, plan, example: example.id,
      out: path.join(root, "missing-history-out"), historyDir: path.join(root, "does-not-exist") });
    expect(missing.status).toBe("refused");
    expect(missing.inputs.every((input) => input.refusal?.startsWith("Cannot open history:"))).toBe(true);
  });
  it("refuses contradictory matching records and malformed history lines without a usable payload", async () => {
    const fixture = await rewindFixture();
    await jsonl(fixture.historyDir, "moments/conflict.jsonl", [emptyRecord(), {
      ...emptyRecord(), memory: [{ id: "self", declaredBy: "agent:a", seq: 1 }]
    }]);
    const refused = await materializeTrainingMoment(fixture.options);
    expect(refused.inputs.filter((input) => input.fidelity !== "overridden")
      .every((input) => input.refusal?.includes("Conflicting moment records"))).toBe(true);
    expect(refused.inputs.find((input) => input.section === "networks")!.fidelity).toBe("overridden");
    expect(await readdir(fixture.options.out)).toEqual(["moment.json"]);
    await jsonl(fixture.historyDir, "moments/conflict.jsonl", [{ invalid: true }]);
    const malformed = await materializeTrainingMoment({ ...fixture.options, out: path.join(fixture.root, "out-2") });
    expect(malformed.inputs[0]!.refusal).toContain("moments/conflict.jsonl:1");
  });
  it("does not overwrite nonempty output or output symlinks", async () => {
    const fixture = await rewindFixture();
    await mkdir(fixture.options.out); await writeFile(path.join(fixture.options.out, "keep"), "keep");
    await expect(materializeTrainingMoment(fixture.options)).rejects.toThrow(/empty directory/);
    expect(await readFile(path.join(fixture.options.out, "keep"), "utf8")).toBe("keep");
    const link = path.join(fixture.root, "out-link"); await symlink(fixture.options.out, link);
    await expect(materializeTrainingMoment({ ...fixture.options, out: link })).rejects.toThrow(/empty directory/);
    const alias = path.join(fixture.root, "history-alias"); await symlink(fixture.historyDir, alias);
    await expect(materializeTrainingMoment({ ...fixture.options, out: path.join(alias, "output") })).rejects.toThrow(/must not overlap/);
    expect(await readdir(fixture.historyDir)).not.toContain("output");
  });
  it("catches a deliberately broken git producer that copies full history", async () => {
    const fixture = await rewindFixture(), correct = gitMaterializer.materializeGit;
    vi.spyOn(gitMaterializer, "materializeGit").mockImplementation(async (context) => {
      const result = await correct(context);
      await cp(path.join(fixture.gitRepo, ".git"), path.join(context.destination, ".git"), { recursive: true });
      return result;
    });
    const result = await materializeTrainingMoment(fixture.options);
    expect(result.status).toBe("refused");
    expect(result.inputs.find((input) => input.id === "code")!.refusal).toContain("git-object");
    expect(await readdir(fixture.options.out)).toEqual(["leak-check.json", "moment.json"]);
    expect(JSON.parse(await readFile(path.join(fixture.options.out, "leak-check.json"), "utf8")).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ class: "git-object", path: "resources/team%3Apublication/code",
        detail: `Object ${fixture.futureCommit} is not reachable from ${fixture.commit}` })]));
    expect(result.at).toBe(AT);
  });
});
