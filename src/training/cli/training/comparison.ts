import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { deriveAuthoredCandidate, type CandidateManifest } from '../../candidates/index.js';
import { one, type CliArguments } from '../arguments.js';
import { readCliText } from '../datasets.js';
import type { CliIO } from '../types.js';

/** Freeze dataset-relative replacement bytes before runtime or inference construction. */
export function prepareComparison(args: CliArguments, io: CliIO, baseline: CandidateManifest) {
  const authored = args.command === 'train' ? args.training?.comparison : undefined;
  if (!authored) return undefined;
  const root = realpathSync(dirname(resolve(io.cwd, one(args, 'train'))));
  const replacements: Record<string, string> = {};
  for (const replacement of authored.candidate.replacements) {
    const path = realpathSync(resolve(root, replacement.source));
    const within = relative(root, path);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('Comparison replacement escapes dataset directory');
    replacements[replacement.resource] = readCliText(path, 1_048_576);
  }
  return { candidate: deriveAuthoredCandidate(baseline, replacements), name: authored.candidate.name };
}
