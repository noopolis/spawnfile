import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileSelector, TaskInput } from '../../contracts/dataset.js';
import type { ArtifactSnapshot } from '../../contracts/evaluation.js';

export function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export function relativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error(`Expected a confined relative path: ${path}`);
  }
  return path;
}
export async function confinedFile(root: string, path: string): Promise<string> {
  relativePath(path);
  const base = await realpath(root);
  let cursor = base;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlink in selected path');
  }
  const canonical = await realpath(cursor);
  const rel = relative(base, canonical);
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Selected path escapes resource');
  if (!(await lstat(canonical)).isFile()) throw new Error('Selected path is not a file');
  return canonical;
}
async function readConfined(root: string, path: string): Promise<Buffer> {
  const selected = await confinedFile(root, path);
  const file = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error('Selected file is not a private regular file');
    if (before.size > 32 * 1024 * 1024) throw new Error('Selected input exceeds 32 MiB');
    const bytes = await file.readFile();
    const current = await lstat(await confinedFile(root, path));
    const after = await file.stat();
    if (current.dev !== after.dev || current.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Selected file changed while being captured');
    return bytes;
  } finally { await file.close(); }
}
export async function readSelected(file: FileSelector, resources: Readonly<Record<string, string>>): Promise<string> {
  const root = resources[file.resource];
  if (!root) throw new Error(`Unmapped input resource ${file.resource}`);
  const bytes = await readConfined(root, file.path);
  if (digest(bytes) !== file.sha256) throw new Error(`Pinned input changed: ${file.resource}/${file.path}`);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export async function stageInput(input: TaskInput, workspace: string, resources: Readonly<Record<string, string>>,
  known: Record<string, string>): Promise<string> {
  const names: string[] = [];
  for (const file of input.files ?? []) {
    const path = `inputs/${relativePath(file.resource)}/${relativePath(file.path)}`;
    const text = await readSelected(file, resources);
    if (Object.hasOwn(known, path)) {
      if (known[path] !== text) throw new Error('A later stimulus replaces an existing input');
    } else {
      // Every parent must be host-created or verified, not a subject-created symlink.
      let cursor = workspace;
      for (const part of dirname(path).split('/')) {
        cursor = join(cursor, part);
        await mkdir(cursor, { mode: 0o700 }).catch(async error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(cursor)).isDirectory()) throw error;
        });
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Subject redirected input directory');
      }
      await writeFile(resolve(workspace, path), text, { flag: 'wx', mode: 0o400 });
      known[path] = text;
    }
    names.push(path);
  }
  return [input.prompt, input.data === undefined ? undefined : JSON.stringify(input.data),
    input.message === undefined ? undefined : JSON.stringify(input.message),
    names.length ? `Input files:\n${names.join('\n')}` : undefined].filter(value => value !== undefined).join('\n\n');
}
export async function collectOutputs(outputs: Readonly<Record<string, string>>, workspace: string,
  boundary: string): Promise<Record<string, ArtifactSnapshot>> {
  const artifacts: Record<string, ArtifactSnapshot> = {};
  for (const [name, path] of Object.entries(outputs)) {
    let bytes: string;
    try { bytes = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readConfined(workspace, path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let value: unknown = bytes;
    try { value = JSON.parse(bytes); } catch { /* Plain text is a first-class output. */ }
    artifacts[name] = { name, checkpointId: `${boundary}/${name}`, digest: digest(bytes), bytes, value,
      provenance: `workspace:${path}` };
  }
  return artifacts;
}
