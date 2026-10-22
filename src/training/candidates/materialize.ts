import { mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CandidateManifest, MaterializationReceipt } from './types.js';
import { assertPlainDirectory } from './filesystem.js';
import { digestBytes } from './identity.js';
import { validateCandidate } from './validation.js';

export async function materializeCandidate(candidate: CandidateManifest, freshRoot: string): Promise<MaterializationReceipt[]> {
  validateCandidate(candidate);
  await mkdir(freshRoot, { recursive: true, mode: 0o700 });
  await assertPlainDirectory(freshRoot);
  if ((await readdir(freshRoot)).length) throw new Error('Candidate installation requires an empty trial-owned directory');
  const actualRoot = await realpath(freshRoot);
  const receipts: MaterializationReceipt[] = [];
  for (const resource of candidate.resources) {
    for (const destination of resource.destinations) {
      const path = resolve(actualRoot, destination.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(resource.content, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      const check = await open(path, 'r');
      try {
        if (digestBytes(await check.readFile()) !== resource.digest) throw new Error('Installed candidate bytes do not match their manifest');
      } finally { await check.close(); }
      receipts.push({ resourceId: resource.id, destination: { ...destination }, digest: resource.digest, evidence: 'installed' });
    }
  }
  return receipts;
}
