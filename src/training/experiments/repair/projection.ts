import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { repairDigest, type MeasurementRepairReceipt } from './receipt.js';

const fileSchema = z.object({ path: z.string().min(1).max(2048), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().max(67_108_864) }).strict();

/** A capture-only readonly projection, never a full former runtime home. */
export async function verifyRepairProjection(receipt: MeasurementRepairReceipt): Promise<void> {
  const root = receipt.parent.root;
  const manifestStat = await lstat(join(root, 'projection-manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 2_097_152) throw new Error('Unsafe parent projection manifest');
  const bytes = await readFile(join(root, 'projection-manifest.json'));
  if (bytes.length > 2_097_152 || repairDigest(bytes) !== receipt.parent.manifestDigest) throw new Error('Parent projection manifest changed');
  const manifest = z.object({ version: z.literal('paideia.repair-parent.v1'),
    files: z.array(fileSchema).min(1).max(10000) }).strict().parse(JSON.parse(bytes.toString('utf8')));
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (file.path.includes('\\') || posix.normalize(file.path) !== file.path || file.path.startsWith('/') ||
        file.path.split('/').some(part => part === '' || part === '.' || part === '..') ||
        !/^(?:runs\/|blobs\/|checkpoint\/(?:command|training|host|optimizer)\.json$)/u.test(file.path) || paths.has(file.path)) {
      throw new Error('Unsafe or duplicate repair projection path');
    }
    paths.add(file.path); total += file.size;
  }
  if (total > 536_870_912) throw new Error('Parent capture projection exceeds 512 MiB');
  const actual = new Set<string>();
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 16 || actual.size > 10000) throw new Error('Parent projection structure exceeds bounds');
    for (const name of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) throw new Error('Parent projection contains a symlink');
      if (stat.isDirectory()) await walk(path, depth + 1);
      else if (stat.isFile()) { if (path !== 'projection-manifest.json') actual.add(path); }
      else throw new Error('Parent projection contains a non-file');
    }
  };
  await walk('', 0);
  if (actual.size !== paths.size || [...actual].some(path => !paths.has(path))) throw new Error('Parent projection file set changed');
  for (const file of manifest.files) {
    const stat = await lstat(join(root, file.path));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw new Error('Parent projection evidence size or kind changed');
    const content = await readFile(join(root, file.path));
    if (content.length !== file.size || repairDigest(content) !== file.sha256) throw new Error('Parent projection evidence bytes changed');
  }
}
