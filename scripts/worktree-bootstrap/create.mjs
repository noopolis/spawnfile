import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
const defaultRun = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
export const worktreeRoot = ({ item, worktreeBase = process.env.SPAWNFILE_WORKTREE_BASE || "/tmp/noopolis-worktrees" }) => {
  const resolvedBase = realpathSync(path.resolve(worktreeBase));
  return path.join(resolvedBase, item, "spawnfile");
};
export const worktreeLayout = (selected) => selected.some((repo) => repo.name === "root") ? "nested" : "standalone";
export const worktreePath = ({ repo, rootWorktree, layout }) => repo.name === "root" ? rootWorktree : layout === "nested" ? path.join(rootWorktree, "ecosystem", repo.name) : path.join(path.dirname(rootWorktree), repo.name);
export const createWorktree = ({ repo, rootWorktree, item, listed, nested = false, force = false, mainCheckout, run = defaultRun }) => {
  // The root install's own npm workspace links point at ../../ecosystem/<name>, so with root selected
  // the ecosystem repos MUST be nested for the root install to resolve at all. Placement is a
  // property of the layout, while branching is a property of the lane's write scope: conflating
  // them silently gives a lane either a dangling workspace link or a branch in a repo it cannot write to.
  const target = worktreePath({ repo, rootWorktree, layout: nested ? "nested" : "standalone" });
  if (mainCheckout && path.resolve(target) === path.resolve(mainCheckout)) throw new Error("WORKTREE REFUSING: " + path.resolve(target) + " is the main checkout, not a worktree. Bootstrap never writes to the main checkout.");
  if (existsSync(target)) {
    if (!force) return { path: target, created: false };
    if (lstatSync(target).isSymbolicLink()) throw new Error("WORKTREE BOOTSTRAP INVALID: " + path.resolve(target) + " is a symlink. Refusing to recreate it.");
    rmSync(target, { recursive: true, force: true });
  }
  const args = ["worktree", "add"];
  if (listed) args.push("-b", "loop/" + item); else args.push("--detach");
  args.push(target, "HEAD");
  run(args, repo.source);
  return { path: target, created: true };
};
export const createAllWorktrees = ({ registry, selected, rootWorktree, item, force, mainCheckout, run = defaultRun }) => {
  const paths = {};
  const nested = worktreeLayout(selected) === "nested";
  for (const repo of selected) paths[repo.name] = createWorktree({ repo, rootWorktree, item, listed: true, nested, force, mainCheckout, run }).path;
  if (nested) for (const repo of Object.values(registry)) if (repo.name !== "root" && !paths[repo.name]) paths[repo.name] = createWorktree({ repo, rootWorktree, item, listed: false, nested, force, mainCheckout, run }).path;
  return paths;
};
