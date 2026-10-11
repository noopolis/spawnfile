import { readFile } from 'node:fs/promises';
import { gradeOutput } from '../../graders/index.js';
import { buildGradingRuntime } from './runtime.js';
import type { GraderDependencies } from './backend.js';

export interface GradeOptions {
  graderFile: string;
  outputFile: string;
  contextFiles?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

/** Standalone grading has no trial snapshot; check gates therefore remain unknown. */
export async function runGrade(options: GradeOptions, dependencies: GraderDependencies = {}) {
  options.signal?.throwIfAborted();
  const output: unknown = JSON.parse(await readFile(options.outputFile, 'utf8'));
  const runtime = await buildGradingRuntime(options.graderFile, dependencies, options.signal);
  const context: Record<string, unknown> = {};
  for (const [name, file] of Object.entries(options.contextFiles ?? {})) {
    if (!Object.hasOwn(runtime.grader.context, name)) throw new Error(`Unknown grader context ${name}`);
    const text = await readFile(file, 'utf8');
    context[name] = file.endsWith('.json') ? JSON.parse(text) as unknown : text;
  }
  return gradeOutput({ ...runtime, output, context, signal: options.signal });
}
