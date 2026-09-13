import type { ViewerCostRange } from '../types.js';

export type MetricSplit = 'train' | 'validation' | 'test' | 'unknown';

export interface CandidateGroup {
  id: string;
  label: string;
  sourceIds: string[];
  selected: boolean;
  /** Declared case splits represented by recorded trials; unmapped cases are unknown. */
  splits: MetricSplit[];
}

export interface MetricDefinition {
  id: string;
  label: string;
  kind: 'strict' | 'stage' | 'check';
  stageId?: string;
}

export interface MetricSummary {
  candidateId: string;
  split: MetricSplit;
  metricId: string;
  /** Mean of sampled case means, with repeated numeric trials averaged per case. */
  value: number | null;
  observedTrials: number;
  trialCount: number;
  observedCases: number;
  expectedCases: number | null;
}

export interface PairedComparison {
  baselineId: string;
  candidateId: string;
  split: MetricSplit;
  metricId: string;
  baselineValue: number | null;
  candidateValue: number | null;
  delta: number | null;
  matchedCases: number;
  expectedCases: number | null;
}

export interface GateSummary {
  candidateId: string;
  split: MetricSplit;
  stageId: string;
  label: string;
  pass: number;
  fail: number;
  unknown: number;
  error: number;
  skipped: number;
  trialCount: number;
  observedCases: number;
  expectedCases: number | null;
}

export type TokenField = 'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens'
  | 'cacheWrite5mInputTokens' | 'cacheWrite1hInputTokens' | 'outputTokens' | 'reasoningTokens';

export interface TokenSummary {
  /** Null when any recorded entry lacks this field, no entries exist, or summation overflows. */
  value: number | null;
  knownSubtotal: number | null;
  knownEntries: number;
  entryCount: number;
}

export interface RecordedCostGroup {
  role: string;
  name: string;
  source: 'valuation' | 'usage';
  models: string[];
  unknownModelEntries: number;
  entryCount: number;
  amount: ViewerCostRange | null;
  knownSubtotal: ViewerCostRange | null;
  tokens: Record<TokenField, TokenSummary>;
}

export interface CockpitMetrics {
  candidates: CandidateGroup[];
  metrics: MetricDefinition[];
  scores: MetricSummary[];
  comparisons: PairedComparison[];
  gates: GateSummary[];
  costs: RecordedCostGroup[];
  /** Same order and length as ViewerData.trials, using the shared identity/split authority. */
  trialIndex: { id: string; candidateId: string; split: MetricSplit }[];
  unknownCaseTrials: number;
}
