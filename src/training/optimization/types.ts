import type { InferenceResult, StopReceipt } from '../contracts/execution.js';
import type { DspyEvaluation, DspyEvaluateParams, DspyGenerateParams } from './protocol.js';

export interface DspyOptimizationOptions {
  id: string;
  components: Readonly<Record<string, string>>;
  trainCaseIds: readonly string[];
  validationCaseIds: readonly string[];
  budget: { maxMetricCalls: number; maxProposals: number };
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
  evaluate(request: Readonly<DspyEvaluateParams>, signal: AbortSignal): Promise<DspyEvaluation>;
  generate(request: Readonly<DspyGenerateParams>, signal: AbortSignal): Promise<InferenceResult>;
  signal?: AbortSignal;
}

export interface DspyFailureEvidence {
  evaluations: number;
  proposals: number;
  hostWork: 'settled' | 'incomplete';
  stop?: StopReceipt;
}

export class DspyOptimizationError extends Error {
  constructor(readonly code: string, message: string, readonly evidence: DspyFailureEvidence) {
    super(message);
    this.name = 'DspyOptimizationError';
  }
}
