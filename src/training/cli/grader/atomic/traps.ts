import { join } from 'node:path';
import type { CouncilOutput } from '../../../graders/references/index.js';
import { generateTraps } from '../../../graders/traps/index.js';
import { stableDigest } from '../../../graders/index.js';
import { atomicWrite, readDecompositions, readOptional, readTemplates } from './files.js';

export interface TrapsOptions { templatesFile: string; decompositions: string; out: string; seed?: string; references?: string; allowRejections?: boolean; signal?: AbortSignal }
export async function runTraps(options: TrapsOptions) {
  options.signal?.throwIfAborted();
  const templates = await readTemplates(options.templatesFile);
  const inputs = await readDecompositions(options.decompositions, templates, options.allowRejections);
  const reference = options.references ? await readOptional<{ digest: string; templatesDigest: string; outputs: Record<string, CouncilOutput> }>(options.references) : undefined;
  if (options.references) {
    if (!reference) throw new Error('Missing base references');
    const { digest, ...content } = reference;
    if (digest !== stableDigest(content) || reference.templatesDigest !== stableDigest(templates)) throw new Error('Stale or corrupt base references');
  }
  let generated = 0, discarded = 0, missingChecks = 0;
  for (const input of inputs) {
    options.signal?.throwIfAborted();
    const base = reference?.outputs[input.file];
    if (reference && (!base?.complete || base.outputDigest !== input.digest)) throw new Error('Stale or incomplete base references');
    const baseFinals = base ? Object.fromEntries(Object.entries(base.checks).map(([id, check]) => [id, check.final])) : {};
    missingChecks += input.doc.rejected?.length ?? 0;
    const identity = stableDigest({ baseFinals, input: input.digest, seed: options.seed ?? '0', protocol: 'paideia.traps.v1' });
    const file = join(options.out, `${stableDigest(input.file)}.traps.json`);
    const previous = await readOptional<{ identity: string }>(file);
    if (previous && previous.identity !== identity) throw new Error(`Stale trap checkpoint: ${input.file}`);
    const result = generateTraps(templates, input.doc, input.inputs, { seed: options.seed ?? '0', baseFinals });
    await atomicWrite(file, { ...result, identity, decomposition: input.file, decompositionDigest: input.digest });
    generated += result.traps.length;
    discarded += result.discarded;
  }
  return { generated, discarded, missingChecks, directory: options.out };
}
