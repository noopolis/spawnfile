import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFeedSource } from "../../../volume/index.js";
import type { MaterializedMoment } from "./contract.js";
import { materializeFeed } from "./feed.js";
import { materializeGit } from "./git.js";
import * as gitProcess from "./gitProcess.js";
import { commitTestGit, gitTestRoot, initTestGit, testGit } from "./git.test-helper.js";
import { History } from "./history.js";
import { leakCheckTrainingMoment } from "./leakCheck.js";
import { finalizeTrainingMoment } from "./materialize.js";
import { stampTree } from "./timestamps.js";
import type { InputContext, InputResult } from "./types.js";

const AT = "2026-10-09T08:20:31Z", BEFORE = "2026-10-09T08:00:00Z", AFTER = "2026-10-11T00:00:00Z";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
type Kind = "git" | "bundle" | "feed";
const fixture = async (kind: Kind) => {
  const root = await gitTestRoot(); roots.push(root);
  const historyDir = path.join(root, "history"), key = "agent%3Awriter/source";
  const repository = path.join(historyDir, kind === "feed" ? `feeds/${key}/repo` : `git/${key}`);
  await initTestGit(repository);
  const commit = await commitTestGit(repository, { "data.txt": "past bytes\n" }, BEFORE);
  const bundle = path.join(root, "stage"), relative = `resources/${key}`, destination = path.join(bundle, relative);
  const declaration = kind === "feed"
    ? { id: "source", kind: "volume" as const, mode: "mutable" as const, mount: "./data", name: "source", feed: { git: { repo: repository } } }
    : kind === "git" ? { id: "source", kind, mode: "readonly" as const, mount: "./data", url: repository }
      : { id: "source", kind, mode: "readonly" as const, mount: "./data", build: { files: { root: repository } } };
  const context: InputContext = { at: AT, destination, history: new History(historyDir), record: null,
    input: { section: "resources", id: "source", declaredBy: "agent:writer", declarationBase: root, declaration, overridden: false } };
  const landing = async (selected: string) => {
    const revision = resolveFeedSource({ kind: "git", fetch: false, repo: repository, ref: selected }).revision;
    const directory = path.dirname(repository), retained = path.join(directory, "trees", revision);
    await mkdir(retained, { recursive: true });
    await writeFile(path.join(retained, "data.txt"), "past bytes\n");
    await writeFile(path.join(directory, "landings.jsonl"), JSON.stringify({ version: "spawnfile.volume-feed-landing.v1", resource: "source", volume: "source", source: { kind: "git", repo: repository }, revision, tree: revision, commit: selected,
      ref: "main", landed_at: BEFORE }) + "\n");
    await stampTree(retained, BEFORE, AT);
  };
  const stage = async () => {
    const result: InputResult = await (kind === "feed" ? materializeFeed(context) : materializeGit(context));
    const moment: MaterializedMoment = { version: "spawnfile.materialized-moment.v1", status: "materialized", agent: "agent:writer",
      example: { id: "example", role: "test", dataset: "dataset" }, at: AT, effectiveAt: AT, record: { matched: false }, leakCheck: { ok: false, findings: 0 },
      inputs: [{ section: "resources", id: "source", declaredBy: "agent:writer", kind, fidelity: result.fidelity,
        basis: result.basis, source: result.source, path: relative, notes: [], refusal: null }] };
    await writeFile(path.join(bundle, "moment.json"), JSON.stringify(moment));
    await stampTree(bundle, BEFORE, AT);
    return moment;
  };
  const future = (role: string) => {
    testGit(repository, ["commit", "--allow-empty", "-m", "future", `--date=${role === "author" ? AFTER : BEFORE}`], role === "committer" ? AFTER : BEFORE);
    return testGit(repository, ["rev-parse", "HEAD"]);
  };
  if (kind === "feed") await landing(commit);
  return { root, historyDir, repository, bundle, relative, destination, context, commit, landing, stage, future };
};

describe("independent source commit provenance", () => {
  it.each(["author", "committer"])("refuses retained future feed bytes when the producer's %s guard is deleted", async (role) => {
    const f = await fixture("feed"), commit = f.future(role);
    await f.landing(commit); // Eligible landing, future source, retained bytes with normalized timestamps.
    const guard = vi.spyOn(gitProcess, "assertCommitNotFuture").mockResolvedValue(undefined);
    const moment = await f.stage(); guard.mockRestore();
    expect(moment.inputs[0]).toMatchObject({ fidelity: "exact", source: { commit } });
    expect(await readFile(path.join(f.destination, "current/data.txt"), "utf8")).toBe("past bytes\n");
    await stampTree(f.bundle, BEFORE, AT);
    const out = path.join(f.root, "refused");
    expect((await finalizeTrainingMoment(f.bundle, out, { historyDir: f.historyDir })).status).toBe("refused");
    const check = JSON.parse(await readFile(path.join(out, "leak-check.json"), "utf8"));
    expect(check.findings).toEqual([{ input: { section: "resources", id: "source", declaredBy: "agent:writer" },
      class: "git-object", path: f.relative, detail: `Provenance commit ${commit} has a future ${role} date` }]);
    expect(await readdir(out)).toEqual(["leak-check.json", "moment.json"]);
  });

  it.each((["git", "bundle", "feed"] as const).flatMap((kind) => ["author", "committer", "blob"].map((role) => ({ kind, role }))))
    ("re-reads $kind source provenance and refuses $role on disk", async ({ kind, role }) => {
      const f = await fixture(kind), moment = await f.stage();
      expect((await leakCheckTrainingMoment(f.bundle, { historyDir: f.historyDir })).findings).toEqual([]);
      const commit = role === "blob" ? testGit(f.repository, ["rev-parse", `${f.commit}:data.txt`]) : f.future(role);
      moment.inputs[0]!.source.commit = commit;
      await writeFile(path.join(f.bundle, "moment.json"), JSON.stringify(moment));
      if (kind === "feed") {
        const file = path.join(f.destination, ".spawnfile-feed.json"), identity = JSON.parse(await readFile(file, "utf8"));
        identity.source.commit = commit; await writeFile(file, JSON.stringify(identity));
      }
      await stampTree(f.bundle, BEFORE, AT);
      const check = await leakCheckTrainingMoment(f.bundle, { historyDir: f.historyDir });
      expect(check.findings).toContainEqual(expect.objectContaining({ class: "git-object", path: f.relative,
        detail: role === "blob" ? `Provenance object ${commit} must be a commit object; found blob`
          : `Provenance commit ${commit} has a future ${role} date` }));
      expect(check.findings.some((finding) => finding.class === "file-time")).toBe(false);
    });

  it.each(["git", "bundle"] as const)("keeps local pinned %s provenance verifiable without a history directory", async (kind) => {
    const f = await fixture(kind);
    if (f.context.input.section !== "resources") throw new Error("Expected resource");
    const resource = f.context.input.declaration;
    if (resource.kind === "git") resource.ref = f.commit;
    if (resource.kind === "bundle") resource.build!.files!.ref = f.commit;
    f.context.history = undefined;
    const moment = await f.stage();
    expect(moment.inputs[0]!.source).toEqual({ commit: f.commit, repository: f.repository });
    expect((await leakCheckTrainingMoment(f.bundle)).findings).toEqual([]);
    await rm(f.repository, { recursive: true });
    expect((await leakCheckTrainingMoment(f.bundle)).findings).toContainEqual(expect.objectContaining({ class: "git-object" }));
  });

  it("refuses inconsistent feed commit identities even when both commits are historical", async () => {
    const f = await fixture("feed"); await f.stage();
    const other = await commitTestGit(f.repository, {}, BEFORE);
    const file = path.join(f.destination, ".spawnfile-feed.json"), identity = JSON.parse(await readFile(file, "utf8"));
    identity.source.commit = other; await writeFile(file, JSON.stringify(identity));
    await stampTree(f.bundle, BEFORE, AT);
    expect((await leakCheckTrainingMoment(f.bundle, { historyDir: f.historyDir })).findings)
      .toContainEqual(expect.objectContaining({ class: "git-object", detail: "Feed source commit disagrees with moment provenance" }));
  });
});
