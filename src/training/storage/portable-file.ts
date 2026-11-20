import { join } from 'node:path';
import { contentDigest } from './content.js';
import { immutableWrite, initializeStoreRoot, safeStorePath } from './filesystem.js';

/** Use the trial identity directly when it is a portable, case-stable basename. */
function trialEvalName(id: string): string {
  const base = /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id) ? id : '_' + contentDigest(id).slice(7);
  return base + '.eval';
}

export async function writeTrialEvalFile(root: string, id: string, bytes: string): Promise<string> {
  const name = trialEvalName(id);
  const path = await safeStorePath(await initializeStoreRoot(root), ['evals', name]);
  await immutableWrite(path, bytes);
  return join('evals', name);
}
