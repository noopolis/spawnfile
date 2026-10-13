import { resolve } from 'node:path';
import { one, count, type CliArguments } from '../../arguments.js';
import type { CliIO } from '../../types.js';
import type { GraderDependencies } from '../backend.js';
import { runDecompose } from './decompose.js';
import { runTraps } from './traps.js';
import { runReference } from './reference.js';
export { runDecompose } from './decompose.js';
export { runTraps } from './traps.js';
export { runReference } from './reference.js';

export async function runAtomicCommand(args: CliArguments, io: CliIO, dependencies: GraderDependencies, signal?: AbortSignal): Promise<number> {
  const templatesFile = resolve(io.cwd, one(args, 'templates')), out = resolve(io.cwd, one(args, 'out'));
  if (args.graderCommand === 'decompose') {
    const result = await runDecompose({ templatesFile, out, signal, inputsFile: resolve(io.cwd, one(args, 'inputs')),
      extractors: one(args, 'extractors').split(',').map(id => id.trim()) }, dependencies);
    io.stdout(`${JSON.stringify(result)}\n`);
    return result.rejected ? 1 : 0;
  }
  const allowRejections = args.flags['allow-rejections'] !== undefined;
  const decompositions = resolve(io.cwd, one(args, 'decompositions'));
  if (args.graderCommand === 'traps') {
    const result = await runTraps({ templatesFile, out, signal, decompositions, allowRejections,
      references: args.flags.references ? resolve(io.cwd, one(args, 'references')) : undefined, seed: one(args, 'seed', '0') });
    io.stdout(`${JSON.stringify(result)}\n`);
    return result.generated ? 0 : 1;
  }
  const result = await runReference({ templatesFile, out, signal, decompositions, allowRejections,
    traps: args.flags.traps ? resolve(io.cwd, one(args, 'traps')) : undefined,
    teachers: one(args, 'teachers').split(',').map(id => id.trim()), concurrency: count(args, 'concurrency', 2, 64),
    batchSize: count(args, 'batch-size', 40, Number.MAX_SAFE_INTEGER),
    timeoutMs: count(args, 'timeout-ms', 180_000, 3_600_000) }, dependencies);
  io.stdout(`${JSON.stringify(result)}\n`);
  return result.gate === 'PASS' ? 0 : 1;
}
