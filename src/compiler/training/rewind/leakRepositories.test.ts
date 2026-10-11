import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTrainingProjects } from "../plan/fixtures.test-helper.js";
import { AT, rewindFixture, testGit } from "./fixtures.test-helper.js";
import { leakCheckTrainingMoment } from "./leakCheck.js";
import { finalizeTrainingMoment, materializeTrainingMoment } from "./materialize.js";
import { stampTree } from "./timestamps.js";

afterEach(cleanTrainingProjects);
const unexpected = "Unexpected .git repository metadata outside the materialized git resource repository";

describe("repository discovery across every bundle input", () => {
  it("refuses a future repository inside retained feed bytes after materializer timestamp stamping", async () => {
    const fixture = await rewindFixture();
    const feedDirectory = path.dirname(fixture.feedRepo);
    const landing = JSON.parse((await readFile(path.join(feedDirectory, "landings.jsonl"), "utf8")).trim());
    const retained = path.join(feedDirectory, "trees", landing.revision);
    await mkdir(retained, { recursive: true });
    await cp(fixture.gitRepo, path.join(retained, "nested"), { recursive: true });
    await stampTree(retained, AT, AT);
    const result = await materializeTrainingMoment(fixture.options);
    expect(result.status).toBe("refused");
    const check = JSON.parse(await readFile(path.join(fixture.options.out, "leak-check.json"), "utf8"));
    expect(check.findings).toContainEqual(expect.objectContaining({ class: "git-object",
      path: `resources/team%3Apublication/news/trees/${landing.revision}/nested/.git`, detail: unexpected }));
    expect(check.findings.filter((finding: { class: string }) => finding.class !== "git-object")).toEqual([]);
    expect(await readdir(fixture.options.out)).toEqual(["leak-check.json", "moment.json"]);
  });

  it.each(["repository", "gitfile", "bare"] as const)("refuses an unexpected %s inside a bundle with all timestamps backdated", async (kind) => {
    const fixture = await rewindFixture(), moment = await materializeTrainingMoment(fixture.options);
    expect(moment.status).toBe("materialized");
    const input = moment.inputs.find((entry) => entry.kind === "git")!;
    input.kind = "bundle";
    const directory = path.join(fixture.options.out, input.path!);
    await rm(path.join(directory, ".git"), { recursive: true });
    const nested = path.join(directory, "nested");
    let relative = `${input.path}/nested/.git`, detail = unexpected;
    if (kind === "repository") await cp(fixture.gitRepo, nested, { recursive: true });
    else if (kind === "gitfile") {
      await mkdir(nested);
      // Detection must refuse this metadata without following the textual pointer.
      await writeFile(path.join(nested, ".git"), `gitdir: ${fixture.gitRepo}/.git\n`);
    } else {
      testGit(fixture.root, ["clone", "--quiet", "--bare", "--no-local", fixture.gitRepo, nested]);
      relative = `${input.path}/nested`;
      detail = "Unexpected bare repository (HEAD, objects/, refs/) outside the materialized git resource repository";
    }
    await writeFile(path.join(fixture.options.out, "moment.json"), JSON.stringify(moment));
    await stampTree(fixture.options.out, AT, AT);
    const check = await leakCheckTrainingMoment(fixture.options.out, { historyDir: fixture.historyDir });
    expect(check.findings).toContainEqual(expect.objectContaining({ class: "git-object", path: relative, detail }));
    expect(check.findings.filter((finding) => finding.class !== "git-object")).toEqual([]);
    const out = path.join(fixture.root, "rejected");
    expect((await finalizeTrainingMoment(fixture.options.out, out, { historyDir: fixture.historyDir })).status).toBe("refused");
    expect(await readdir(out)).toEqual(["leak-check.json", "moment.json"]);
  });
});
