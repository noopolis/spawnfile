import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { rewindGit } from "./gitProcess.js";
import { instantNanos } from "./instant.js";
import type { LeakCheck, MaterializedInput } from "./contract.js";

/** Enumerate every stored object, independently of the materializer's chosen-object list. */
export const inspectGitBundle = async (repository: string, input: MaterializedInput, report: LeakCheck): Promise<void> => {
  const add = (detail: string) => report.findings.push({
    input: { section: input.section, id: input.id, declaredBy: input.declaredBy },
    class: "git-object", path: input.path!, detail
  });
  const gitDir = path.join(repository, ".git");
  if (!(await lstat(gitDir)).isDirectory()) throw new Error("The materialized repository must have its own .git directory");
  const names = new Set(await readdir(gitDir));
  for (const name of ["FETCH_HEAD", "ORIG_HEAD", "logs", "packed-refs", "commondir", "shallow"]) {
    if (names.has(name)) add(`Forbidden git metadata ${name}`);
  }
  const config = await readFile(path.join(gitDir, "config"), "utf8");
  if (/^\s*\[\s*(?:include|includeif)\b/imu.test(config)) throw new Error("Git configuration includes are forbidden");
  for (const name of ["objects/info/alternates", "objects/info/http-alternates", "info/grafts"]) {
    const exists = await lstat(path.join(gitDir, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (exists) throw new Error(`Git object indirection ${name} is forbidden`);
  }
  const localConfig = (await rewindGit(repository, ["config", "--local", "--no-includes", "--list", "--null"]))
    .toString().split("\0").filter(Boolean);
  for (const entry of localConfig) {
    const key = entry.split("\n")[0]!.toLowerCase();
    if (key.startsWith("remote.") || key === "core.worktree" || key === "extensions.partialclone") add(`Forbidden git configuration ${key}`);
  }
  const refs = (await rewindGit(repository, ["for-each-ref", "--format=%(refname) %(objectname)"])).toString().trim().split("\n").filter(Boolean);
  const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
  const commit = input.source.commit;
  if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Error("Missing materialized commit identity");
  if (refs.length !== 1 || !refs[0]!.startsWith("refs/heads/") || refs[0]!.split(" ")[1] !== commit
    || head !== `ref: ${refs[0]?.split(" ")[0]}`) add("Exactly one branch and HEAD must name the materialized commit");
  const reachable = new Set((await rewindGit(repository, ["rev-list", "--objects", commit, "--"]))
    .toString().split("\n").filter(Boolean).map((line) => line.split(" ")[0]));
  const objects = (await rewindGit(repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]))
    .toString().trim().split("\n").filter(Boolean);
  report.checked.gitObjects += objects.length;
  for (const row of objects) {
    const [oid, kind] = row.split(" ");
    if (!reachable.has(oid)) add(`Object ${oid} is not reachable from ${commit}`);
    if (kind !== "commit") continue;
    const object = (await rewindGit(repository, ["cat-file", "commit", oid!])).toString();
    const headers = object.split("\n\n", 1)[0]!;
    for (const role of ["author", "committer"]) {
      const match = new RegExp(`^${role} .* (-?\\d+) [+-]\\d{4}$`, "mu").exec(headers);
      if (!match) { add(`Commit ${oid} has no valid ${role} date`); continue; }
      if (BigInt(match[1]!) * 1_000_000_000n > instantNanos(report.at)) add(`Commit ${oid} has a future ${role} date`);
    }
  }
};
