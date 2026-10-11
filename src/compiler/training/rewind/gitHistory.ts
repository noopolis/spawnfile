import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { History } from "./history.js";
import { rewindGit } from "./gitProcess.js";

/** Git's textual indirections are not covered by ordinary realpath containment. */
export const assertLocalGitRepository = async (repository: string, history?: History): Promise<void> => {
  const exists = (file: string) => history ? history.path(path.relative(history.root, file)) : lstat(file).then(() => file, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const text = (file: string) => history ? history.text(path.relative(history.root, file)) : readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const dotGit = path.join(repository, ".git");
  if (history && await exists(dotGit) && !(await lstat(dotGit)).isDirectory()) throw new Error("History repository .git indirection files are not supported; retain a standalone repository");
  // `git -C` would discover an ancestor repository if this history directory is not itself one.
  if (history && !await exists(dotGit) && (!await exists(path.join(repository, "HEAD")) || !await exists(path.join(repository, "objects")))) {
    throw new Error("History entry is not a standalone git repository");
  }
  // Check config includes before asking git anything: even rev-parse reads included config files.
  if (history) {
    const directory = await exists(dotGit) ? dotGit : repository;
    // `commondir` is another textual redirect git follows during discovery, before any command runs.
    for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "shallow", "info/grafts"]) {
      if (await text(path.join(directory, name))) throw new Error(`Rewind requires complete standalone git history; ${name} is unsupported`);
    }
    const configFile = path.join(directory, "config");
    const configText = await text(configFile);
    if (configText && /^\s*\[\s*include(?:if)?\b/imu.test(configText)) throw new Error("Rewind refuses git configuration indirection include");
  }
  // Resolve only after refusing textual worktree links that could leave the history root.
  const gitDirectory = (await rewindGit(repository, ["rev-parse", "--absolute-git-dir"])).toString().trim();
  if (history) await history.path(path.relative(history.root, gitDirectory));
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "shallow", "info/grafts"]) {
    if (await text(path.join(gitDirectory, name))) throw new Error(`Rewind requires complete standalone git history; ${name} is unsupported`);
  }
  const config = (await rewindGit(repository, ["config", "--local", "--no-includes", "--list", "--null"]))
    .toString().split("\0").filter(Boolean);
  for (const entry of config) {
    const key = entry.split("\n")[0]!.toLowerCase();
    if (key === "include.path" || /^includeif\..*\.path$/u.test(key) || key === "extensions.partialclone" || /^remote\..*\.promisor$/u.test(key)) {
      throw new Error(`Rewind refuses git configuration indirection ${key}`);
    }
  }
  const packs = path.join(gitDirectory, "objects/pack");
  if (await exists(packs) && (await readdir(packs)).some((name) => name.endsWith(".promisor"))) throw new Error("Rewind refuses incomplete promisor git history");
};
