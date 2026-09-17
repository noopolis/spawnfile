import type { NativeChildExternalInputs } from '../index.js';
import type { VerifiedNativeLaunch } from '../receipt/index.js';
import type { GrokSlotFreshnessStore } from './slot-freshness.js';

export interface NativeChildExecution {
  kind: 'child-process';
  externalInputs?: NativeChildExternalInputs;
  /** Caller-owned staging only; the package does not import subscription credentials. */
  /** Required for Grok launches: the experiment's persisted slot recycle freshness (nonce and generation floor). */
  grokSlots?: GrokSlotFreshnessStore;
  prepare?(context: { launch: VerifiedNativeLaunch; trialId: string; signal: AbortSignal }): Promise<void>;
}
