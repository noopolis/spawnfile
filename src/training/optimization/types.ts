import type { InferenceAttempt, InferenceResult, StopReceipt } from '../contracts/execution.js';
import type { TrainingProposalPolicy } from '../contracts/training-config.js';
import type { DspyEvaluation, DspyEvaluateParams, DspyGenerateParams } from './protocol.js';

export interface DspyOptimizationOptions {
  id: string;
  components: Readonly<Record<string, string>>;
  trainCaseIds: readonly string[];
  validationCaseIds: readonly string[];
  budget: { maxMetricCalls: number; maxProposals: number };
  proposal?: TrainingProposalPolicy;
  /** GEPA sampling only; this is not a native model sampling control. */
  seed?: number;
  bridge: {
    command: string;
    args?: string[];
    cwd: string;
    timeoutMs: number;
    closureDrainMs?: number;
    maxBytes?: number;
  };
  validateComponents(components: Readonly<Record<string, string>>, signal: AbortSignal): void | Promise<void>;
  evaluate(request: Readonly<DspyEvaluateParams>, signal: AbortSignal, callbackId?: string): Promise<DspyEvaluation>;
  generate(request: Readonly<DspyGenerateParams>, signal: AbortSignal, callbackId?: string): Promise<InferenceResult>;
  onRestore?: (evidence: DspyRestoredEvidence) => Promise<void>;
  checkpoint?: { directory: string; resume: boolean; identity: string; fork?: OptimizationFork };

  signal?: AbortSignal;
}

/** Trusted measurement-repair import, bound to separately verified parent evidence. */
export interface OptimizationFork {
  directory: string;
  identity: string;
  id: string;
  /** Exact parent Python paired checkpoint file digest. */
  digest: string;
  /** Exact parent host callback journal file digest. */
  hostDigest: string;
}

export interface DspyFailureEvidence {
  evaluations: number;
  proposals: number;
  hostWork: 'settled' | 'incomplete';
  inferenceAttempts?: readonly InferenceAttempt[];
  stop?: StopReceipt;
}

export class DspyOptimizationError extends Error {
  constructor(readonly code: string, message: string, readonly evidence: DspyFailureEvidence) {
    super(message);
    this.name = 'DspyOptimizationError';
  }
}

export interface DspyRestoredEvidence {
  generations: Array<Omit<InferenceResult, 'text'> & { callbackId: string }>;
  failedAttempts: InferenceAttempt[];
  reservations: Array<{ id: string; method: 'evaluate' | 'generate'; attempts: number; settledAttempts: number; completed: boolean }>;
}
