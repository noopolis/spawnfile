import { dirname, isAbsolute, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { JudgeRoute } from '../../contracts/evaluation.js';
import { openJudgeCache } from '../../storage/index.js';
import type { CliArguments } from '../arguments.js';

/** Persistent caches are protected execution resources, opened only on actual execution. */
export async function prepareJudgeCaches(args: CliArguments, judges: Record<string, JudgeRoute>, out: string, executionRoot?: string): Promise<string[]> {
  const policy = args.training?.cache;
  if (policy?.mode !== 'persistent' || !Object.keys(judges).length) return [];
  if (executionRoot !== undefined && (!isAbsolute(executionRoot) || await realpath(executionRoot) !== executionRoot || !(await lstat(executionRoot)).isDirectory())) {
    throw new Error('Judge cache execution root must be an existing canonical absolute directory');
  }
  const root = executionRoot !== undefined ? await containedCacheRoot(executionRoot, policy.directory ?? 'judge-cache')
    : policy.directory === undefined ? resolve(out, 'judge-cache')
    : await containedCacheRoot(dirname(args.frozenDataset!.path), policy.directory);
  for (const [name, route] of Object.entries(judges)) {
    if (!route.identity) throw new Error('Persistent cache requires an authored judge route');
    const namespace = createHash('sha256').update(JSON.stringify([policy.namespace, name])).digest('hex');
    route.cache = await openJudgeCache({root, namespace,
      maxEntries: policy.max_entries ?? 1000, maxBytes: 32 * 1024 * 1024 });
  }
  return [await realpath(root)];
}

async function containedCacheRoot(directory: string, relative: string): Promise<string> {
  let current = await realpath(directory);
  for (const component of relative.split('/')) {
    if (!component || component === '.' || component === '..' || component.includes('\\') || component.includes('\0') || /^[A-Za-z]:/.test(component)) {
      throw new Error('Cache directory requires a contained relative path');
    }
    current = resolve(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Cache directory cannot contain symlinks');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}
