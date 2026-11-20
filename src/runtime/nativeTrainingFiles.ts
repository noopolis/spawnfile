import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { TrialDocker } from "../compiler/training/trial/index.js";

/** Evaluated paths may reach declared workspace resources that the compiler mounted outside the workspace. */
const reader = `
const fs = require("node:fs"), path = require("node:path");
const [file, ...roots] = process.argv.slice(1);
try {
  const canonical = fs.realpathSync(file);
  if (!roots.some(root => {
    const base = fs.realpathSync(root);
    return canonical.startsWith(base + "/");
  })) throw Error("Selected file leaves its declared roots");
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw Error("Selected file is not a bounded, unshared regular file");
    const bytes = fs.readFileSync(fd);
    const current = fs.statSync(file);
    if (bytes.length !== info.size || current.dev !== info.dev || current.ino !== info.ino ||
        current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw Error("Selected file changed during capture");
    process.stdout.write(JSON.stringify(new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes)));
  } finally { fs.closeSync(fd); }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  process.stdout.write("null");
}`;

export async function readNativeFile(
  docker: TrialDocker, container: string, file: string, roots: readonly string[]
): Promise<string | null> {
  if (!path.posix.isAbsolute(file) || file !== path.posix.normalize(file)) throw new Error("Expected a canonical container path");
  const bytes: unknown = JSON.parse(await docker(["exec", "--user", "spawnfile", container, "node", "-e", reader, file, ...roots]));
  if (bytes !== null && typeof bytes !== "string") throw new Error("Invalid native file response");
  return bytes;
}

const installInput = `
const fs = require("node:fs"), path = require("node:path");
const [workspace, relative] = process.argv.slice(1);
let dir = fs.realpathSync(workspace);
const parts = relative.split("/");
if (parts[0] !== "inputs" || parts.some(part => !part || part === "." || part === "..")) throw Error("Invalid dataset input");
for (const part of parts.slice(0, -1)) {
  dir = path.join(dir, part);
  try { fs.mkdirSync(dir); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!fs.lstatSync(dir).isDirectory()) throw Error("Redirected dataset input directory");
}
fs.writeFileSync(path.join(dir, parts.at(-1)), fs.readFileSync(0), {flag: "wx", mode: 0o400});`;

/** The core stages new pinned input files on the host before each turn. Only those files enter the container. */
export function nativeInputSync(docker: TrialDocker, container: string, hostWorkspace: string, workspace: string) {
  const installed = new Set<string>();
  const directory = path.join(hostWorkspace, "inputs");
  return async (signal?: AbortSignal): Promise<void> => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (!entry.isFile()) throw new Error("Dataset input is not a regular file");
      const source = path.join(entry.parentPath, entry.name);
      const relative = path.relative(hostWorkspace, source).split(path.sep).join("/");
      if (installed.has(relative)) continue;
      await docker(["exec", "-i", "--user", "spawnfile", container, "node", "-e", installInput, workspace, relative],
        { stdin: await readFile(source), signal });
      installed.add(relative);
    }
  };
}
