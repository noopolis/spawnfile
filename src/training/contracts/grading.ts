import type { JudgeCall } from './evaluation.js';

/** Runtime-neutral option scoring; expectedOptions is bounds metadata, never prompt data. */
export interface DecisionRequest {
  key: string;
  type: 'yes-no' | 'noul' | 'choice' | 'score';
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
  /** Infrastructure refusal, distinct from missing behavioral evidence. */
  failureCause?: 'spend-cap' | 'request-rejected';
  bounded?: boolean;
  /** Provider probabilities have approximately 0.01 resolution, even when their sum is one. */
  providerRounded?: boolean;
  teacherAnswered?: boolean;
  /** Actual subscription attempts, absent for local option scorers. */
  judgeCalls?: JudgeCall[];
}
export interface DecisionIdentity { backend: string; model: string; digest?: string; fingerprint?: string; endpoint?: string }
export interface DecisionSpendBudget { maxUsd?: number; spentUsd: number; reservedUsd: number }
export interface DecisionRequestReceipt {
  billing: 'api'; model: string; endpoint: string;
  inputTokens: number | null; outputTokens: number | null; usd: number | null;
  estimatedInputTokens: number; estimatedUsd: number; latencyMs: number; status: number | null;
}
export interface DecisionAccounting {
  billing: 'api'; requests: number; inputTokens: number | null; outputTokens: number | null; usd: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  receipts: DecisionRequestReceipt[];
}
export interface DecisionBackend {
  capabilities?: { billing: 'local' | 'subscription' | 'api'; batch?: boolean };
  /** Diagnostic history only; never use for invocation accounting. */
  requestReceipts?(): DecisionRequestReceipt[];
  /** Append only this call's dispatched receipts, including failures, before settling. */
  identity(signal?: AbortSignal, receipts?: DecisionRequestReceipt[]): Promise<DecisionIdentity>;
  score(requests: DecisionRequest[], signal?: AbortSignal, receipts?: DecisionRequestReceipt[]): Promise<DecisionResult[]>;
}
