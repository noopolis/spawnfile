import { loadRuntimeRegistry, type RuntimeRegistryEntry } from './registry.js';
import { createCodexAdapter } from './codex-exec/training/index.js';
import type { SubjectAdapterRegistry } from '../training/subjects/index.js';
import type { CliDependencies } from '../training/cli/index.js';
import { main as trainingMain } from '../training/cli/index.js';
import { prepareNative as prepareCoreNative } from '../training/cli/native.js';

/** codex-exec is a standalone subject, never a compiled Spawnfile runtime. */
export async function createTrainingSubjects(entries?: readonly RuntimeRegistryEntry[]): Promise<SubjectAdapterRegistry> {
  const registered = entries ?? await loadRuntimeRegistry();
  const subjects = await Promise.all(registered.flatMap(entry => entry.training
    ? [entry.training.subject().then(subject => [entry.name, subject] as const)] : []));
  return Object.freeze({
    ...Object.fromEntries(subjects),
    codex: { create: createCodexAdapter },
  });
}

export async function trainingDependencies(dependencies: CliDependencies = {}): Promise<CliDependencies> {
  return { ...dependencies, subjects: dependencies.subjects ?? await createTrainingSubjects() };
}

/** Shared host/container composition of the runtime-neutral training CLI. */
export async function main(...[argv, io, dependencies]: Parameters<typeof trainingMain>): Promise<number> {
  return trainingMain(argv, io, await trainingDependencies(dependencies));
}

export async function prepareNative(...[args, io, dependencies, ...rest]: Parameters<typeof prepareCoreNative>) {
  return prepareCoreNative(args, io, await trainingDependencies(dependencies), ...rest);
}
