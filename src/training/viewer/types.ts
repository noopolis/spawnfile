import type { InferenceModelBasis, JudgeFailure, ObservationCoverage, Usage } from '../src/contracts/index.js';

/** A caller-filtered presentation projection. Never pass raw captures or prompts. */
export interface ViewerData {
  schema: 'paideia.viewer.v1';
  experiment: {
    id: string;
    title: string;
    status: string;
    phase: 'evaluation' | 'train' | 'validation' | 'final-test' | 'replay';
    updatedAt: string;
  };
  cases: { id: string; split: 'train' | 'validation' | 'test'; label?: string }[];
  trials: {
    id: string;
    caseId: string;
    candidateId: string;
    status: string;
    score: number | null;
    coverage: ObservationCoverage[];
    checks: ViewerCheck[];
    events: ViewerEvent[];
  }[];
  candidates: {
    id: string;
    /** Explicit authored arm name; absent for historical optimizer candidates. */
    label?: string;
    /** Native content identity; distinct GEPA discoveries may use identical bytes. */
    nativeId?: string;
    parentIds: string[];
    validationScore: number | null;
    discoveryEvaluations: number;
    editablePaths: string[];
  }[];
  usage: ViewerUsage[];
  costs?: ViewerCosts;
  activity?: ViewerActivity;
  heldOut?: { candidateId: string; meanScore: number; trialScores?: number[]; standardError?: number | null }[];
  optimizer?: {
    name: string;
    status: string;
    evaluations: number;
    proposals: number;
    maxMetricCalls: number;
    maxProposals: number;
    selectedCandidateId?: string;
  };
}

export interface ViewerActivity {
  trialId: string;
  caseId: string;
  phase: 'train' | 'validation' | 'test';
  status: string;
  toolCalls: number;
  judgeCalls: number;
  measurements: { stageId: string; criterionId: string; kind: 'criterion' | 'gate' | 'score';
    status: string; score: number | null; weight?: number; weightedContribution?: number | null;
    judgeFailure?: JudgeFailure }[];
}

export interface ViewerCheck {
  weight?: number;
  weightedContribution?: number | null;
  /** Why an errored judge produced no score, as a closed vocabulary. Absent on every other verdict. */
  judgeFailure?: JudgeFailure;
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown' | 'error' | 'skipped';
  score: number | null;
  evidenceIds: string[];
  children: ViewerCheck[];
}

export interface ViewerEvent { id: string; type: string; timestamp: string; summary: string }

export interface ViewerUsage {
  purpose: 'subject' | 'optimizer' | 'judge' | 'embedding';
  model: string | null;
  modelBasis?: InferenceModelBasis;
  route: string | null;
  usage: Usage | null;
}

export interface ViewerCostRange { low: number; high: number }
export interface ViewerPriceSource { checkedAt: string; source: string | null }
export interface ViewerCostTokens {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  cacheWrite5mInputTokens: number | null;
  cacheWrite1hInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  invalid: boolean;
}
export interface ViewerCosts {
  planned?: {
    total: ViewerCostRange | null;
    knownSubtotal: ViewerCostRange;
    coverage: 'estimated' | 'partial';
    lines: { role: string; name: string; phase: string; model: string; provider: string | null;
      plannedCalls: number; amount: ViewerCostRange | null; price: ViewerPriceSource | null }[];
  };
  observed?: {
    total: ViewerCostRange | null;
    knownSubtotal: ViewerCostRange;
    completeness: 'complete' | 'incomplete';
    usageCoverage: 'observed-only' | 'incomplete';
    groups: { role: string; name: string; entryCount: number; amount: ViewerCostRange | null; knownSubtotal: ViewerCostRange }[];
    lines: { role: string; name: string; model: string | null; requestedModel: string | null;
      modelBasis: 'provider-reported' | 'requested-assumption' | 'unknown';
      provider: string | null; route: string | null; outcome: string; usage: ViewerCostTokens | null;
      valuationStatus: string; amount: ViewerCostRange | null; price: ViewerPriceSource | null }[];
  };
}

export interface ViewerOptions {
  load: () => Promise<ViewerData>;
  port?: number;
  /** Explicit container listener only; caller must publish on host loopback. */
  bindHost?: '127.0.0.1' | '0.0.0.0';
}
export interface ViewerServer { url: string; port: number; close(finalSnapshot?: ViewerData): Promise<void> }
