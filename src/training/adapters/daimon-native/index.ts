export { createDaimonNativeAdapter } from './adapter.js';
export type { NativeAdapterOptions } from './adapter.js';
export { parseNativeLaunch, nativeLaunchSchema } from './receipt/index.js';
export type { NativeLaunch, NativeMount, VerifiedNativeLaunch } from './receipt/index.js';

/**
 * Launch preflight for callers that prepare a trial: `loadNativeLaunch` verifies
 * the receipt and its path policy without starting anything, and
 * `nativeTrialArtifactsRoot` is where that trial's private control artifacts
 * land (the control root for Codex, a per-trial directory inside it for Grok).
 * Both are derivations callers must not reimplement.
 */
export { loadNativeLaunch } from './container/index.js';
export { nativeTrialArtifactsRoot } from './receipt/index.js';

export type { NativeExternalInputs, NativeExternalInput, NativeChildExternalInputs } from './external.js';

export { createNativeHttpClient } from './transport/index.js';
export type { NativeExecutionHandle, NativeWorkerPath, NativeWorkerRequest } from './transport/index.js';

export { createGrokSlotFreshnessStore, nativeChildArguments } from './child/index.js';
export type { GrokSlotFreshness, GrokSlotFreshnessStore, NativeChildExecution } from './child/index.js';

export { grokBrokerControlSocketEnv, grokGrantHomeRootEnv, loadDaimonGrokGrantAuthority } from './grants/index.js';

/**
 * Operator-only turn transcript: the wake text the engine received and the reply
 * it gave, read from the engine's own session record inside the Daimon-owned
 * engine home and confirmed against Daimon's closed trace digest. Published as a
 * `raw`-visibility diagnostic observation; never an evaluated output.
 */
export { readNativeTranscript, NATIVE_TRANSCRIPT_SCHEMA } from './transcript.js';
export type { NativeTranscriptCapture, NativeTranscriptSession, NativeTranscriptText } from './transcript.js';
