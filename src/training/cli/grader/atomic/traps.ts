import { join } from 'node:path';
import { generateTraps } from '../../../graders/traps/index.js';
import { stableDigest } from '../../../graders/index.js';
import { atomicWrite, readDecompositions, readOptional, readTemplates } from './files.js';

export interface TrapsOptions { templatesFile: string; decompositions: string; out: string; seed?: string; signal?: AbortSignal }
export async function runTraps(options: TrapsOptions) {
  options.signal?.throwIfAborted();
  const templates = await readTemplates(options.templatesFile);
  const inputs = await readDecompositions(options.decompositions, templates);
  let generated = 0, discarded = 0;
  for (const input of inputs) {
    options.signal?.throwIfAborted();
    const identity = stableDigest({ input: input.digest, seed: options.seed ?? '0', protocol: 'paideia.traps.v1' });
    const file = join(options.out, `${stableDigest(input.file)}.traps.json`);
    const previous = await readOptional<{ identity: string }>(file);
    if (previous && previous.identity !== identity) throw new Error(`Stale trap checkpoint: ${input.file}`);
    const result = generateTraps(templates, input.doc, input.inputs, { seed: options.seed ?? '0' });
    await atomicWrite(file, { ...result, identity, decomposition: input.file, decompositionDigest: input.digest });
    generated += result.traps.length;
    discarded += result.discarded;
  }
  return { generated, discarded, directory: options.out };
}
