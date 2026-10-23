import { readFile } from 'node:fs/promises';
import { expandInstances, gradeOutput, loadGrader, type Grader } from '../../graders/index.js';
import { buildGradingRuntime } from './runtime.js';
import type { GraderDependencies } from './backend.js';

export interface GradeOptions {
  graderFile: string;
  maxSpendUsd?: number;
  outputFile: string;
  contextFiles?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

/** Standalone grading has no trial snapshot; check gates therefore remain unknown. */
export async function runGrade(options: GradeOptions, dependencies: GraderDependencies = {}) {
  options.signal?.throwIfAborted();
  const output: unknown = JSON.parse(await readFile(options.outputFile, { encoding: 'utf8', signal: options.signal }));
  const runtime = await buildGradingRuntime(options.graderFile, { ...dependencies, maxSpendUsd: options.maxSpendUsd ?? dependencies.maxSpendUsd }, options.signal);
  const context = await readContexts(runtime.grader, options);
  return gradeOutput({ ...runtime, output, context, signal: options.signal });
}

/** Label builders use the same expansion and unit boundaries as grading, without inference. */
export async function runExpand(options: GradeOptions) {
  options.signal?.throwIfAborted();
  const grader = await loadGrader(options.graderFile);
  const output: unknown = JSON.parse(await readFile(options.outputFile, { encoding: 'utf8', signal: options.signal }));
  const context = await readContexts(grader, options);
  options.signal?.throwIfAborted();
  return { instances: expandInstances(grader, output, context).map(({ key, questionId, level, unit, state, reasons, projectionDigest }) => ({
    key, questionId, level, unit, state, ...(reasons.length ? { reason: reasons.join('; ') } : {}), projectionDigest,
  })) };
}

async function readContexts(grader: Grader, options: GradeOptions): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {};
  for (const [name, file] of Object.entries(options.contextFiles ?? {})) {
    if (!Object.hasOwn(grader.context, name)) throw new Error(`Unknown grader context ${name}`);
    const text = await readFile(file, { encoding: 'utf8', signal: options.signal });
    context[name] = file.endsWith('.json') ? JSON.parse(text) as unknown : text;
  }
  return context;
}
