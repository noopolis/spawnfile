import { resolve } from 'node:path';
import type { CliArguments } from '../arguments.js';
import type { CliIO } from '../types.js';
import { one, count, pairs } from '../arguments.js';
import { runLabelImport } from './label-import.js';
import { runLabel } from './label.js';
import { runValidate } from './validate.js';
import { runCalibrate } from './calibrate.js';
import { runExpand, runGrade } from './grade.js';
import type { GraderDependencies } from './backend.js';
import { runAtomicCommand } from './atomic/index.js';

export { runLabel, createGraderTeacher } from './label.js';
export { runCalibrate } from './calibrate.js';
export { runValidate } from './validate.js';
export { runExpand, runGrade } from './grade.js';
export { buildGradingRuntime } from './runtime.js';
export type { GraderDependencies } from './backend.js';

export async function runGraderCommand(args: CliArguments, io: CliIO, dependencies: GraderDependencies = {}, signal?: AbortSignal): Promise<number> {
  if (['decompose', 'traps', 'reference'].includes(args.graderCommand ?? '')) return runAtomicCommand(args, io, dependencies, signal);
  const graderFile = resolve(io.cwd, one(args, 'grader'));
  if (args.graderCommand === 'validate') {
    io.stdout(`${JSON.stringify(await runValidate(graderFile, dependencies, signal))}\n`);
    return 0;
  }
  if (args.graderCommand === 'grade' || args.graderCommand === 'expand') {
    const options = { graderFile, outputFile: resolve(io.cwd, one(args, 'output')),
      contextFiles: Object.fromEntries(Object.entries(pairs(args.flags.context ?? [])).map(([name, file]) => [name, resolve(io.cwd, file)])),
      signal };
    if (args.graderCommand === 'expand') {
      io.stdout(`${JSON.stringify(await runExpand(options))}\n`);
      return 0;
    }
    const result = await runGrade(options, dependencies);
    io.stdout(`${JSON.stringify(result)}\n`);
    return result.status === 'pass' ? 0 : 1;
  }
  if (args.graderCommand === 'label' && args.flags.import) {
    const result = await runLabelImport({ graderFile, importFile: resolve(io.cwd, one(args, 'import')),
      relabel: Boolean(args.flags.relabel), signal });
    io.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const concurrency = count(args, 'concurrency', 2, 64);
  if (args.graderCommand === 'label') {
    const result = await runLabel({ graderFile, inputsFile: resolve(io.cwd, one(args, 'inputs')),
      teachers: one(args, 'teachers').split(',').map(value => value.trim()), relabel: Boolean(args.flags.relabel),
      adjudication: args.flags.adjudication ? count(args, 'adjudication', 0, 1_000_000, 0) : undefined,
      limit: args.flags.limit ? count(args, 'limit', 1, 1_000_000) : undefined, concurrency, signal }, dependencies);
    io.stdout(`${JSON.stringify(result)}\n`);
    for (const [teacher, kind] of Object.entries(result.stopped)) io.stderr(`Teacher ${teacher} stopped: ${kind}\n`);
    return result.missing || Object.keys(result.stopped).length ? 1 : 0;
  }
  const result = await runCalibrate({ graderFile,
    excludeDatasets: (args.flags['exclude-dataset'] ?? []).map(file => resolve(io.cwd, file)),
    seed: one(args, 'seed', '0'), reportFile: args.flags.report ? resolve(io.cwd, one(args, 'report')) : undefined,
    concurrency, signal }, dependencies);
  io.stdout(`${JSON.stringify({ calibrationFile: result.calibrationFile, reportFile: result.reportFile, code: result.code })}\n`);
  return result.code;
}
