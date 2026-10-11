import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitTestGit, gitTestRoot, initTestGit, testGit } from "./git.test-helper.js";
import { commitAt, selectCommitAt } from "./gitProcess.js";

const EARLY = "2026-10-09T08:00:00Z", AT = "2026-10-09T08:20:31Z", LATE = "2026-10-09T09:00:00Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const repository = async (): Promise<string> => {
  const root = await gitTestRoot(); roots.push(root);
  const repo = path.join(root, "repo"); await initTestGit(repo); return repo;
};

describe("historical commit selection", () => {
  it.each(["author", "committer"] as const)("steps back past a commit with a future %s date", async (role) => {
    const repo = await repository(), past = await commitTestGit(repo, { "readme.txt": "past\n" }, EARLY);
    await commitTestGit(repo, { "readme.txt": "future\n" }, AT);
    testGit(repo, ["commit", "--amend", "--no-edit", `--date=${role === "author" ? LATE : AT}`], role === "committer" ? LATE : AT);
    expect(await commitAt(repo, "main", AT)).toMatchObject({ commit: past, instant: "2026-10-09T08:00:00.000Z" });
  });

  it("has no eligible state when every ancestor is future-authored", async () => {
    const repo = await repository(); await commitTestGit(repo, { "readme.txt": "future\n" }, EARLY);
    testGit(repo, ["commit", "--amend", "--no-edit", `--date=${LATE}`], EARLY);
    expect(await commitAt(repo, "main", AT)).toBeNull();
  });

  it("filters author and committer dates before choosing the newest eligible candidate", () => {
    const eligible = { commit: "eligible", instant: EARLY, authorInstant: AT };
    expect(selectCommitAt([
      { commit: "future-author", instant: AT, authorInstant: LATE },
      { commit: "future-committer", instant: LATE, authorInstant: EARLY }, eligible
    ], AT)).toEqual(eligible);
    expect(selectCommitAt([{ commit: "equal", instant: AT, authorInstant: "2026-10-09T10:20:31+02:00" }], AT)?.commit).toBe("equal");
  });
});
