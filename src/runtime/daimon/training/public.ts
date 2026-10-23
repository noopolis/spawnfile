/** Interim Daimon integration surface; importing it never starts a worker. */
export {
  assertNativeEngineConfig, bindTrialPathsToSlot, createDaimonNativeAdapter,
  createExperimentSlotFreshness, loadNativeLaunch, nativeChildArguments,
  nativeSubjectScratch, nativeTrialArtifactsRoot, nativeTrialInputsRoot,
  parseNativeLaunch, prepareNativeSubject,
} from './native/index.js';
export type {
  GrokSlotFreshnessStore, NativeAdapterOptions, NativeChildExternalInputs,
  NativeLaunch, NativeMount, NativeSubjectEngine, NativeTransportDelivery,
  NativeTurnEvidence, ProvisionedSubject, SubjectProvisioner,
} from './native/index.js';
export { nativeChildEnvironment } from './native/child/index.js';
export { verifyExternalSource, verifyNativeWorkerStartup } from './native/worker/index.js';
export type { TerminalEvidence } from './native/worker/index.js';
