import { installBuiltinGraderProviders } from './trainingGraderProviders.js';
import { createTrainingProviderRegistry } from './trainingProviders.js';
import { loadRuntimeRegistry, type RuntimeRegistryEntry } from './registry.js';
import type { SubjectAdapterRegistry } from '../training/subjects/index.js';
import type { CliDependencies } from '../training/cli/index.js';
import { main as trainingMain } from '../training/cli/index.js';

export async function createTrainingSubjects(entries?: readonly RuntimeRegistryEntry[]): Promise<SubjectAdapterRegistry> {
  const registered = entries ?? await loadRuntimeRegistry();
  const subjects = await Promise.all(registered.flatMap(entry => entry.training
    ? [entry.training.subject().then(subject => [entry.name, subject] as const)] : []));
  return Object.freeze(Object.fromEntries(subjects));
}

export async function trainingDependencies(dependencies: CliDependencies = {}): Promise<CliDependencies> {
  installBuiltinGraderProviders();
  const subjects = dependencies.subjects ?? await createTrainingSubjects();
  return { ...dependencies, subjects,
    inferenceProviders: dependencies.inferenceProviders ?? createTrainingProviderRegistry(),
  };
}

/** Shared host/container composition of the runtime-neutral training CLI. */
export async function main(...[argv, io, dependencies]: Parameters<typeof trainingMain>): Promise<number> {
  return trainingMain(argv, io, await trainingDependencies(dependencies));
}
