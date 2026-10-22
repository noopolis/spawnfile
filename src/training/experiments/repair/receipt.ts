import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(512);
const receiptSchema = z.object({
  version: z.literal('paideia.measurement-repair.v1'),
  parent: z.object({ root: id, imageId: sha, experimentId: id, executionIdentity: id, manifestDigest: sha,
    checkpoints: z.object({ command: sha, training: sha, host: sha, optimizer: sha }).strict(), trainingIdentity: id }).strict(),
  current: z.object({ imageId: sha, canonicalSourceDigest: sha, adapterId: z.literal('daimon-native') }).strict(),
  compatibility: z.object({ version: z.literal('spawnfile.daimon-dspy-compatibility.v1'), digest: sha,
    components: z.record(id, sha), inputs: z.record(id, sha) }).strict(),
}).strict();
export type MeasurementRepairReceipt = z.infer<typeof receiptSchema>;
export const repairDigest = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The launcher produces this protected handoff after proving both image closures. */
export async function readMeasurementRepair(path: string, expected: {
  parentRoot: string; out: string; imageId?: string; adapterId: string; canonicalSourceDigest?: string;
}): Promise<{ receipt: MeasurementRepairReceipt; digest: string }> {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('Repair receipt must be a canonical protected file');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error('Repair receipt must be a bounded regular file');
  const bytes = await readFile(path);
  if (bytes.length > 1_048_576) throw new Error('Repair receipt exceeds its bound');
  const envelope = z.object({ receipt: receiptSchema, digest: sha }).strict().parse(JSON.parse(bytes.toString('utf8')));
  if (repairDigest(JSON.stringify(envelope.receipt)) !== envelope.digest) throw new Error('Repair receipt integrity mismatch');
  const { receipt } = envelope;
  const parent = resolve(expected.parentRoot), out = resolve(expected.out);
  if (receipt.parent.root !== parent || await realpath(parent) !== parent ||
      parent === out || parent.startsWith(out + sep) || out.startsWith(parent + sep)) {
    throw new Error('Measurement repair requires disjoint canonical parent and child outputs');
  }
  if (!expected.imageId || receipt.current.imageId !== expected.imageId || receipt.current.adapterId !== expected.adapterId ||
      !expected.canonicalSourceDigest || receipt.current.canonicalSourceDigest !== expected.canonicalSourceDigest) {
    throw new Error('Measurement repair lacks a matching installed native compatibility authority');
  }
  if (repairDigest(JSON.stringify({ components: receipt.compatibility.components, inputs: receipt.compatibility.inputs })) !== receipt.compatibility.digest) {
    throw new Error('Repair compatibility evidence digest mismatch');
  }
  if (!Object.keys(receipt.compatibility.components).length || !Object.keys(receipt.compatibility.inputs).length) {
    throw new Error('Measurement repair lacks verified component or input evidence');
  }
  return envelope;
}
