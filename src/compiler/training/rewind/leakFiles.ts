import type { BigIntStats } from "node:fs";
import { lstat, lutimes, readdir, readlink, realpath, utimes } from "node:fs/promises";
import path from "node:path";
import { inside } from "./history.js";
import { instantNanos } from "./instant.js";
import type { LeakCheck, MaterializedInput } from "./contract.js";

export const inputAtPath = (inputs: MaterializedInput[], relative: string): MaterializedInput | undefined =>
  inputs.find((input) => input.path !== null && (relative === input.path || relative.startsWith(`${input.path}/`)));

export const diskPath = async (root: string, relative: string): Promise<string> => {
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate) || path.isAbsolute(relative)) throw new Error(`Bundle path escapes root: ${relative}`);
  if (!inside(root, await realpath(candidate))) throw new Error(`Bundle symlink escapes root: ${relative}`);
  return candidate;
};

/** Capture metadata before any inspection read can advance an entry's access time. */
export const snapshotBundleFiles = async (root: string): Promise<Map<string, BigIntStats>> => {
  const files = new Map<string, BigIntStats>();
  const visit = async (file: string): Promise<void> => {
    const stats = await lstat(file, { bigint: true });
    files.set(file, stats);
    if (stats.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
  };
  await visit(root);
  return files;
};

/** Preserve the inspected access times, including future ones; never hide an existing violation. */
export const restoreInspectedAccessTimes = async (files: Map<string, BigIntStats>): Promise<void> => {
  for (const [file, stats] of [...files].reverse()) {
    // Numeric strings preserve sub-millisecond precision; negative numeric arguments mean "now" in Node.
    await (stats.isSymbolicLink() ? lutimes : utimes)(file,
      String(Number(stats.atimeNs / 1_000n) / 1_000_000), String(Number(stats.mtimeNs / 1_000n) / 1_000_000));
  }
};

/** No symlinks are traversed. Inspection never reads a target outside the bundle. */
export const inspectBundleFiles = async (root: string, inputs: MaterializedInput[], report: LeakCheck, files: Map<string, BigIntStats>): Promise<void> => {
  const at = instantNanos(report.at);
  const latestDate = new Date(Math.min(253_402_300_799_999, Date.parse(report.at) + 14 * 3600_000)).toISOString().slice(0, 10);
  const visit = async (file: string): Promise<void> => {
    const relative = path.relative(root, file).split(path.sep).join("/") || ".";
    const owner = inputAtPath(inputs, relative);
    const input = owner ? { section: owner.section, id: owner.id, declaredBy: owner.declaredBy } : null;
    const add = (kind: "bundle-entry" | "file-time" | "symlink-escape" | "dated-path" | "git-object", detail: string) => {
      report.findings.push({ input, class: kind, path: relative, detail });
    };
    const stats = files.get(file)!;
    if (!owner && relative !== ".") {
      const reportFile = ["moment.json", "leak-check.json", "task-clock.json"].includes(relative) && stats.isFile();
      const wrapper = stats.isDirectory() && inputs.some((entry) => entry.path?.startsWith(`${relative}/`));
      if (!reportFile && !wrapper) add("bundle-entry", "Unexpected entry outside the materialized inputs and reports");
    }
    report.checked.files++;
    if (stats.mtimeNs > at) add("file-time", "Modification time is later than the moment");
    if (stats.atimeNs > at) add("file-time", "Access time is later than the moment");
    const allowedGitDirectory = owner?.kind === "git" && relative === `${owner.path}/.git` && stats.isDirectory();
    if (path.basename(file).toLowerCase() === ".git" && !allowedGitDirectory) {
      add("git-object", "Unexpected .git repository metadata outside the materialized git resource repository");
    }
    const head = files.get(path.join(file, "HEAD"));
    const objects = files.get(path.join(file, "objects"));
    const refs = files.get(path.join(file, "refs"));
    if (stats.isDirectory() && head && (head.isFile() || head.isSymbolicLink())
      && objects && (objects.isDirectory() || objects.isSymbolicLink())
      && refs && (refs.isDirectory() || refs.isSymbolicLink()) && !allowedGitDirectory) {
      add("git-object", "Unexpected bare repository (HEAD, objects/, refs/) outside the materialized git resource repository");
    }
    for (const match of path.basename(file).matchAll(/\d{4}-\d{2}-\d{2}/gu)) {
      const date = match[0];
      const parsed = Date.parse(`${date}T00:00:00Z`);
      if (Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(date) && date > latestDate) {
        add("dated-path", `Calendar date ${date} is later than the latest possible local date ${latestDate}`);
      }
    }
    if (stats.isSymbolicLink()) {
      const link = await readlink(file);
      if (path.isAbsolute(link) || !inside(root, path.resolve(path.dirname(file), link))) {
        add("symlink-escape", `Unsafe symlink target ${JSON.stringify(link)}`); return;
      }
      // Even a dangling leaf can cross an existing symlink in a parent component.
      let target = path.resolve(path.dirname(file), link);
      for (;;) {
        try {
          if (!inside(root, await realpath(target))) add("symlink-escape", "Symlink resolves outside the bundle");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            add("symlink-escape", `Cannot resolve symlink: ${String(error)}`); break;
          }
          if (target === root) break;
          target = path.dirname(target);
        }
      }
    } else if (!stats.isDirectory() && !stats.isFile()) add("symlink-escape", "Special files are not allowed in a moment bundle");
  };
  for (const file of files.keys()) await visit(file);
};
