import type { JudgeCall } from './evaluation.js';

/** Runtime-neutral option scoring; expectedOptions is bounds metadata, never prompt data. */
export interface DecisionRequest {
  key: string;
  type: 'yes-no' | 'choice' | 'score';
  optionLabels: readonly (string | number)[];
  expectedOptions?: readonly (string | number)[];
  instructions: string;
  system?: string;
  projection: Record<string, unknown>;
}
export interface DecisionResult {
  key: string;
  probabilities: Record<string, number> | null;
  status: 'ok' | 'missing';
  reason?: string;
  bounded?: boolean;
  teacherAnswered?: boolean;
  /** Actual subscription attempts, absent for local option scorers. */
  judgeCalls?: JudgeCall[];
}
export interface DecisionIdentity { backend: string; model: string; digest?: string }
export interface DecisionBackend {
  identity(): Promise<DecisionIdentity>;
  score(requests: DecisionRequest[], signal?: AbortSignal): Promise<DecisionResult[]>;
}
