import { lstat, readdir, readlink, realpath } from "node:fs/promises";
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

/** No symlinks are traversed. Inspection never reads a target outside the bundle. */
export const inspectBundleFiles = async (root: string, inputs: MaterializedInput[], report: LeakCheck): Promise<void> => {
  const at = instantNanos(report.at);
  const latestDate = new Date(Date.parse(report.at) + 14 * 3600_000).toISOString().slice(0, 10);
  const visit = async (file: string): Promise<void> => {
    const relative = path.relative(root, file).split(path.sep).join("/") || ".";
    const owner = inputAtPath(inputs, relative);
    const input = owner ? { section: owner.section, id: owner.id, declaredBy: owner.declaredBy } : null;
    const add = (kind: "file-time" | "symlink-escape" | "dated-path", detail: string) => {
      report.findings.push({ input, class: kind, path: relative, detail });
    };
    const stats = await lstat(file, { bigint: true });
    report.checked.files++;
    if (stats.mtimeNs > at) add("file-time", "Modification time is later than the moment");
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
    } else if (stats.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
    } else if (!stats.isFile()) add("symlink-escape", "Special files are not allowed in a moment bundle");
  };
  await visit(root);
};
