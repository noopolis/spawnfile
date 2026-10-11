import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { momentRecordSchema, type MomentRecord } from "./contract.js";

export const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
export const safeSegment = (value: string): string => {
  if (!value || value === "." || value === ".." || /[/\\\0]/u.test(value)) throw new Error(`Unsafe history identity ${JSON.stringify(value)}`);
  return value;
};
export const historyKey = (identity: { declaredBy: string; id: string }): string =>
  `${safeSegment(encodeURIComponent(identity.declaredBy))}/${safeSegment(identity.id)}`;
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** All reads of the consumer history layout pass through this containment boundary. */
export class History {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  async path(relative: string): Promise<string | null> {
    if (path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0")) throw new Error(`Unsafe history path ${relative}`);
    const target = path.resolve(this.root, relative);
    if (!inside(this.root, target)) throw new Error(`History path escapes root: ${relative}`);
    let ancestor = target;
    while (true) {
      try {
        const physical = await realpath(ancestor);
        if (!inside(this.root, physical)) throw new Error(`History symlink escape: ${relative}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (ancestor === this.root) throw new Error(`History root no longer exists: ${this.root}`);
        ancestor = path.dirname(ancestor);
      }
    }
    try {
      await lstat(target);
      // A dangling symlink is not a missing history entry.
      const physical = await realpath(target);
      if (!inside(this.root, physical)) throw new Error(`History symlink escape: ${relative}`);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entry = await lstat(target).catch(() => null);
      if (entry?.isSymbolicLink()) throw new Error(`Dangling history symlink: ${relative}`);
      return null;
    }
  }
  async bytes(relative: string): Promise<Buffer | null> {
    const file = await this.path(relative);
    if (file === null) return null;
    if (!(await lstat(await realpath(file))).isFile()) throw new Error(`History entry must be a regular file: ${relative}`);
    return readFile(file);
  }
  async text(relative: string): Promise<string | null> { return (await this.bytes(relative))?.toString("utf8") ?? null; }
  async jsonl<T>(relative: string, schema: z.ZodType<T>): Promise<T[] | null> {
    const payload = await this.text(relative);
    if (payload === null) return null;
    const lines = payload.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line, index) => {
      try { return schema.parse(JSON.parse(line)); }
      catch (error) { throw new Error(`Invalid history ${relative}:${index + 1}: ${reason(error)}`); }
    });
  }
  async records(): Promise<MomentRecord[]> {
    const directory = await this.path("moments");
    if (!directory) return [];
    const records: MomentRecord[] = [];
    const seen = new Set<string>();
    const walk = async (relative: string): Promise<void> => {
      const file = await this.path(relative);
      if (!file) throw new Error(`History entry vanished: ${relative}`);
      const physical = await realpath(file);
      if ((await lstat(physical)).isDirectory()) {
        if (seen.has(physical)) throw new Error(`Repeated moment history directory: ${relative}`);
        seen.add(physical);
        for (const name of (await readdir(file)).sort()) await walk(`${relative}/${name}`);
      } else if (relative.endsWith(".jsonl")) records.push(...(await this.jsonl(relative, momentRecordSchema) ?? []));
      else if (relative.endsWith(".json")) {
        try { records.push(momentRecordSchema.parse(JSON.parse((await this.text(relative))!))); }
        catch (error) { throw new Error(`Invalid history ${relative}: ${reason(error)}`); }
      }
    };
    await walk("moments");
    return records;
  }
  /** Validate all tree entries before git or another local parser receives the directory. */
  async repository(relative: string): Promise<string | null> {
    const root = await this.path(relative);
    if (!root) return null;
    const seen = new Set<string>();
    const walk = async (entry: string): Promise<void> => {
      const file = await this.path(entry);
      if (!file) throw new Error(`History entry vanished: ${entry}`);
      const physical = await realpath(file), stats = await lstat(physical);
      if (seen.has(physical)) return;
      seen.add(physical);
      if (stats.isDirectory()) for (const name of await readdir(file)) await walk(`${entry}/${name}`);
      else if (!stats.isFile()) throw new Error(`Special history file: ${entry}`);
    };
    await walk(relative);
    return root;
  }
  async copyTree(relative: string, destination: string): Promise<void> {
    const source = await this.path(relative);
    if (!source) throw new Error(`Missing retained tree: ${relative}`);
    const stats = await lstat(source);
    if (!stats.isDirectory()) throw new Error(`Retained tree must be a real directory: ${relative}`);
    const copy = async (entry: string, target: string): Promise<void> => {
      const file = await this.path(entry);
      if (!file) throw new Error(`History entry vanished: ${entry}`);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) { await symlink(await readlink(file), target); return; }
      if (stat.isDirectory()) {
        await mkdir(target, { recursive: true });
        for (const name of (await readdir(file)).sort()) await copy(`${entry}/${name}`, path.join(target, name));
      } else if (stat.isFile()) {
        await writeFile(target, (await this.bytes(entry))!);
        await chmod(target, stat.mode & 0o777);
      } else throw new Error(`Special history file: ${entry}`);
    };
    await copy(relative, destination);
  }
}
export const openHistory = async (directory?: string): Promise<History | undefined> => {
  if (directory === undefined) return undefined;
  const root = await realpath(path.resolve(directory));
  if (!(await lstat(root)).isDirectory()) throw new Error(`History must be a directory: ${directory}`);
  return new History(root);
};
