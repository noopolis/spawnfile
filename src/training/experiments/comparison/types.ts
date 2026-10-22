import type { CandidateManifest } from '../../candidates/index.js';
import type { CostReport, TrainingCostPlan } from '../costs/index.js';
import type { RescoreReport } from '../replay/index.js';
import type { TrainingOptions } from '../training/index.js';
import type { TrialReport } from '../trials/index.js';

export interface ComparisonOptions extends Pick<TrainingOptions,
  'id' | 'baseline' | 'train' | 'validation' | 'validationGroups' | 'test' | 'native' | 'checkpoint' | 'signal' | 'onProgress'> {
  candidate: CandidateManifest;
  name: string;
  maxTrials: number;
}
export interface ComparisonReport {
  schema: 'paideia.comparison.v1';
  id: string;
  baseline: CandidateManifest;
  candidate: CandidateManifest;
  name: string;
  partitions: { train: string[]; validation: string[]; test: string[] };
  trials: TrialReport[];
  rescores?: RescoreReport[];
  pairs: { caseId: string; phase: TrialReport['phase']; baselineTrialId: string; candidateTrialId: string;
    baselineScore: number; candidateScore: number; delta: number }[];
  provenance: { mode: 'authored-comparison'; optimizerCalls: 0 };
  costs?: CostReport;
  costPlan?: TrainingCostPlan;
}
