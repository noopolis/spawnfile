import manifest from "./contract-manifest.json" with { type: "json" };

import { parseDaimonContractManifest } from "./contractManifest.js";
import { DAIMON_PINNED_BROKER_DESCRIPTOR, DAIMON_PINNED_PORTABLE_DESCRIPTOR, DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR, type DaimonEngineDescriptor } from "./engineDescriptorSchema.js";

export type { DaimonEngineDescriptor, DaimonEngineDescriptors } from "./engineDescriptorSchema.js";
export const DAIMON_ENGINE_DESCRIPTORS = parseDaimonContractManifest(manifest).engines;
export const DAIMON_ENGINES = Object.freeze(Object.keys(DAIMON_ENGINE_DESCRIPTORS).sort());

/** Source-language omission policy stays in Spawnfile. */
export const DAIMON_DEFAULT_ENGINE = "codex";
export const getDaimonEngineDescriptor = (engine: string): DaimonEngineDescriptor | undefined =>
  Object.hasOwn(DAIMON_ENGINE_DESCRIPTORS, engine) ? DAIMON_ENGINE_DESCRIPTORS[engine] : undefined;
export const daimonEngineHasBroker = (engine: string): boolean =>
  getDaimonEngineDescriptor(engine)?.broker != null;

const byStaging = (staging: DaimonEngineDescriptor["auth"]["staging"], preferredId: string): DaimonEngineDescriptor => {
  const preferred = getDaimonEngineDescriptor(preferredId);
  const descriptor = preferred?.auth.staging === staging ? preferred
    : Object.values(DAIMON_ENGINE_DESCRIPTORS).find((entry) => entry.auth.staging === staging);
  if (!descriptor) throw new Error(`Daimon contract has no ${staging} engine`);
  return descriptor;
};

/** Legacy wire identities retain their generated literal types, never a copied inventory. */
const portableStaging = getDaimonEngineDescriptor(DAIMON_PINNED_PORTABLE_DESCRIPTOR.id)?.auth.staging === "portable-file" ? "portable-file" : "portable-realm";
export const DAIMON_PORTABLE_ENGINE_ID = byStaging(portableStaging, DAIMON_PINNED_PORTABLE_DESCRIPTOR.id).id as typeof DAIMON_PINNED_PORTABLE_DESCRIPTOR.id;
export const DAIMON_BROKER_ENGINE_ID = byStaging("broker-realm", DAIMON_PINNED_BROKER_DESCRIPTOR.id).id as typeof DAIMON_PINNED_BROKER_DESCRIPTOR.id;
export const DAIMON_SECRET_SERVICE_ENGINE_ID = byStaging("secret-service", DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR.id).id as typeof DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR.id;
export const DAIMON_ENGINE_BROKER = byStaging("broker-realm", DAIMON_PINNED_BROKER_DESCRIPTOR.id).broker!;

// Admission additionally consumes training.subject; the declared inventory stays compatible.
export const daimonTrainingDeclaration = { adapterId: "daimon-native", engines: DAIMON_ENGINES } as const;
