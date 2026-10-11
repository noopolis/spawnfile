import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { rewindGit } from "./gitProcess.js";
import { safeCommittedPath } from "./gitTree.js";
import { instantNanos } from "./instant.js";

/** Compare against objects in the output repository, never the index or status' cached stat data. */
export const inspectGitWorktree = async (repository: string, commit: string): Promise<void> => {
  const entries = new Map<string, { mode: string; kind: string; oid: string }>();
  for (const row of (await rewindGit(repository, ["ls-tree", "-rtz", `${commit}^{tree}`])).toString().split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t"), name = safeCommittedPath(row.slice(tab + 1));
    const [mode, kind, oid] = row.slice(0, tab).split(" ");
    entries.set(name, { mode: mode!, kind: kind!, oid: oid! });
  }
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const name of await readdir(directory)) {
      if (!prefix && name === ".git") continue;
      const relative = prefix ? `${prefix}/${name}` : name, file = path.join(directory, name);
      const expected = entries.get(relative), stats = await lstat(file);
      if (!expected) throw new Error(`Unexpected git worktree entry ${relative}`);
      entries.delete(relative);
      if (expected.kind === "tree" && stats.isDirectory()) { await visit(file, relative); continue; }
      if (expected.kind !== "blob" || !["100644", "100755", "120000"].includes(expected.mode)) {
        throw new Error(`Unsupported git worktree entry ${relative}`);
      }
      const bytes = await rewindGit(repository, ["cat-file", "blob", expected.oid]);
      const matches = expected.mode === "120000"
        ? stats.isSymbolicLink() && (await readlink(file, { encoding: "buffer" })).equals(bytes)
        : stats.isFile() && Boolean(stats.mode & 0o111) === (expected.mode === "100755") && (await readFile(file)).equals(bytes);
      if (!matches) throw new Error(`Git worktree entry mismatch: ${relative}`);
    }
  };
  await visit(repository);
  if (entries.size) throw new Error(`Missing git worktree entries: ${[...entries.keys()].join(", ")}`);
};

/** NUL terminates each pathname, so path text cannot masquerade as --debug stat metadata. */
export const inspectGitIndexTimes = async (repository: string, at: string): Promise<void> => {
  const debug = (await rewindGit(repository, ["ls-files", "--debug", "-z"])).toString();
  for (let cursor = 0; cursor < debug.length;) {
    const end = debug.indexOf("\0", cursor);
    const metadata = end < 0 ? null : /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: [^\n]+\n  uid: [^\n]+\n  size: [^\n]+\n/u.exec(debug.slice(end + 1));
    if (!metadata) throw new Error("Invalid git index stat metadata");
    for (const [label, offset] of [["ctime", 1], ["mtime", 3]] as const) {
      const nanos = BigInt(metadata[offset]!) * 1_000_000_000n + BigInt(metadata[offset + 1]!);
      if (nanos > instantNanos(at)) throw new Error(`Git index ${label} is later than the moment: ${debug.slice(cursor, end)}`);
    }
    cursor = end + 1 + metadata[0].length;
  }
};
