import type { NativeChildExternalInputs } from '../index.js';
import type { VerifiedNativeLaunch } from '../receipt/index.js';

export interface NativeChildExecution {
  kind: 'child-process';
  externalInputs?: NativeChildExternalInputs;
  /** Caller-owned staging only; the package does not import subscription credentials. */
  prepare?(context: { launch: VerifiedNativeLaunch; trialId: string; signal: AbortSignal }): Promise<void>;
}
