import { createTrainingProviderRegistry, installBuiltinGraderProviders, withRuntimeTrainingGraders } from './trainingComposition.js';
import { runtimeTrainingRegistrations, type RuntimeTrainingRegistration } from './trainingSelection.js';
import type { SubjectAdapterRegistry } from '../training/subjects/index.js';
import type { CliDependencies } from '../training/cli/index.js';
import { main as trainingMain } from '../training/cli/index.js';

export async function createTrainingSubjects(entries?: readonly RuntimeTrainingRegistration[]): Promise<SubjectAdapterRegistry> {
  const registered = entries ?? await runtimeTrainingRegistrations();
  const subjects = await Promise.all(registered.flatMap(entry => entry.training?.subject
    ? [entry.training.subject().then(subject => [entry.name, subject] as const)] : []));
  return Object.freeze(Object.fromEntries(subjects));
}

export async function composeTrainingDependencies(dependencies: CliDependencies = {}): Promise<CliDependencies> {
  const subjects = dependencies.subjects ?? await createTrainingSubjects();
  return { ...dependencies, subjects,
    inferenceProviders: dependencies.inferenceProviders ?? await createTrainingProviderRegistry(),
  };
}

export async function trainingDependencies(dependencies: CliDependencies = {}): Promise<CliDependencies> {
  await installBuiltinGraderProviders();
  return composeTrainingDependencies(dependencies);
}

/** Shared host/container composition of the runtime-neutral training CLI. */
export async function main(...[argv, io, dependencies]: Parameters<typeof trainingMain>): Promise<number> {
  return withRuntimeTrainingGraders(async () => trainingMain(argv, io, await composeTrainingDependencies(dependencies)));
}
