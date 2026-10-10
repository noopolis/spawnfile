import { resolve } from 'node:path';
import type { CliArguments } from '../arguments.js';
import type { CliIO } from '../types.js';
import { one, count } from '../arguments.js';
import { runLabel } from './label.js';
import { runValidate } from './validate.js';
import { runCalibrate } from './calibrate.js';
import type { GraderDependencies } from './backend.js';

export { runLabel, createGraderTeacher } from './label.js';
export { runCalibrate } from './calibrate.js';
export { runValidate } from './validate.js';
export type { GraderDependencies } from './backend.js';

export async function runGraderCommand(args: CliArguments, io: CliIO, dependencies: GraderDependencies = {}, signal?: AbortSignal): Promise<number> {
  const graderFile = resolve(io.cwd, one(args, 'grader'));
  if (args.graderCommand === 'validate') {
    io.stdout(`${JSON.stringify(await runValidate(graderFile, dependencies))}\n`);
    return 0;
  }
  const concurrency = count(args, 'concurrency', 2, 64);
  if (args.graderCommand === 'label') {
    const result = await runLabel({ graderFile, inputsFile: resolve(io.cwd, one(args, 'inputs')),
      teachers: one(args, 'teachers').split(',').map(value => value.trim()), relabel: Boolean(args.flags.relabel),
      adjudication: args.flags.adjudication ? count(args, 'adjudication', 0, 1_000_000, 0) : undefined,
      limit: args.flags.limit ? count(args, 'limit', 1, 1_000_000) : undefined, concurrency, signal }, dependencies);
    io.stdout(`${JSON.stringify(result)}\n`);
    return result.missing ? 1 : 0;
  }
  const result = await runCalibrate({ graderFile,
    excludeDatasets: (args.flags['exclude-dataset'] ?? []).map(file => resolve(io.cwd, file)),
    seed: one(args, 'seed', '0'), reportFile: args.flags.report ? resolve(io.cwd, one(args, 'report')) : undefined,
    concurrency, signal }, dependencies);
  io.stdout(`${JSON.stringify({ calibrationFile: result.calibrationFile, reportFile: result.reportFile, code: result.code })}\n`);
  return result.code;
}
