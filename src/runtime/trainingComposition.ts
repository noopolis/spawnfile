import { configureGraderProviders, withGraderProviders, type InferenceProviderRegistry } from "../training/contracts/index.js";
import { assembleTrainingGraders } from "./trainingGraderProviders.js";
import { assembleTrainingInference, type TrainingInferenceComposition as InferenceComposition } from "./trainingProviders.js";
import { runtimeTrainingRegistrations, type RuntimeTrainingRegistration } from "./trainingSelection.js";

export type TrainingInferenceComposition = InferenceComposition<RuntimeTrainingRegistration>;

export const composeTrainingInference = async (
  entries?: readonly RuntimeTrainingRegistration[]
): Promise<TrainingInferenceComposition> => {
  const contributions = [];
  for (const owner of entries ?? await runtimeTrainingRegistrations()) {
    const contribution = await owner.training?.loadInferenceProviders?.();
    if (contribution) contributions.push({ owner, contribution });
  }
  return assembleTrainingInference(contributions);
};

export const createTrainingProviderRegistry = async (
  entries?: readonly RuntimeTrainingRegistration[]
): Promise<InferenceProviderRegistry> => (await composeTrainingInference(entries)).registry;

let installed: Promise<void> | undefined;

const createGraderRegistry = async () => {
  const contributions = [];
  for (const { name, training } of await runtimeTrainingRegistrations()) {
    const contribution = await training?.loadGraderProviders?.();
    if (contribution) contributions.push({ name, contribution });
  }
  return assembleTrainingGraders(contributions);
};

export const installBuiltinGraderProviders = (): Promise<void> => {
  installed ??= createGraderRegistry().then(configureGraderProviders);
  return installed;
};


export const withRuntimeTrainingGraders = async <Result>(run: () => Promise<Result>): Promise<Result> =>
  withGraderProviders(await createGraderRegistry(), run);
