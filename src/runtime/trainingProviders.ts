import type { InferenceProviderDescriptor, InferenceProviderRegistry } from "../training/contracts/index.js";
import { defaultInferenceProviders, DatasetError } from "../training/index.js";
import { SpawnfileError } from "../shared/errors.js";
import type { RuntimeTrainingInferenceContribution } from "./trainingProviderTypes.js";

export interface TrainingInferenceComposition<Owner> {
  registry: InferenceProviderRegistry;
  owners: ReadonlyMap<string, Owner>;
}

/** Keep the historical host validation message and preserve earlier shape errors. */
const compatibleDescriptor = (descriptor: InferenceProviderDescriptor): InferenceProviderDescriptor => ({
  ...descriptor,
  validate(model, path) {
    try {
      descriptor.validate(model, path);
    } catch (error) {
      if (error instanceof DatasetError && error.path === `${path}.reasoning_effort` && model.reasoning_effort !== undefined) {
        throw new DatasetError(error.path, "only supported for grok-subscription or grok-broker");
      }
      throw error;
    }
  }
});

export const assembleTrainingInference = <Owner extends { name: string }>(
  contributions: readonly { owner: Owner; contribution: RuntimeTrainingInferenceContribution }[]
): TrainingInferenceComposition<Owner> => {
  const providers = new Map(Object.entries(defaultInferenceProviders.providers).map(([id, descriptor]) =>
    [id, compatibleDescriptor(descriptor)]));
  const owners = new Map<string, Owner>();
  const order = new Set<string>();
  let brokerAdmissionLabel = defaultInferenceProviders.brokerAdmissionLabel;
  for (const { owner, contribution } of contributions) {
    if (contribution.brokerAdmissionLabel && brokerAdmissionLabel && contribution.brokerAdmissionLabel !== brokerAdmissionLabel) {
      throw new SpawnfileError("validation_error", `Multiple runtimes claim training broker admission at ${owner.name}`);
    }
    brokerAdmissionLabel = contribution.brokerAdmissionLabel ?? brokerAdmissionLabel;
    for (const id of contribution.providerOrder ?? []) order.add(id);
    for (const [id, descriptor] of Object.entries(contribution.providers)) {
      if (providers.has(id)) throw new SpawnfileError("validation_error", `Duplicate training inference provider ${id} on runtime ${owner.name}`);
      providers.set(id, descriptor);
      owners.set(id, owner);
    }
  }
  const sorted = new Map<string, InferenceProviderDescriptor>();
  for (const id of order) {
    const descriptor = providers.get(id);
    if (descriptor) sorted.set(id, descriptor);
  }
  for (const [id, descriptor] of providers) sorted.set(id, descriptor);
  return { registry: { ...defaultInferenceProviders, brokerAdmissionLabel, providers: Object.fromEntries(sorted) }, owners };
};
