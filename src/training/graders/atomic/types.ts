import type { JudgeCall } from '../../contracts/evaluation.js';
import type { DecisionBackend, DecisionRequestReceipt, DecisionResult } from '../../contracts/grading.js';
import type { Decomposition, DecompositionInputs, CheckTemplates, CheckInstance } from '../decomposition/index.js';
import type { AtomicGrader } from './format.js';

export interface AtomicExtraction {
  decomposition?: Decomposition;
  /** Protected extraction/audit responses and validation diagnostics, never optimizer payload. */
  receipts: Record<string, unknown>[];
  judgeCalls: JudgeCall[];
  error?: string;
}
export interface AtomicRuntime {
  kind: 'atomic'; grader: AtomicGrader; templates: CheckTemplates;
  definitionDigest: string; templatesDigest: string;
  resource: object; resources?: object[];
  backend: DecisionBackend;
  extract(inputs: DecompositionInputs, signal?: AbortSignal): Promise<AtomicExtraction>;
}
export interface AtomicCheckScore {
  check: CheckInstance; occurrence: string; unit: string; kind: string; dimension: string; severity: 'critical' | 'major' | 'minor';
  /** Null is missing, never a successful zero-confidence judgment. */
  probability: number | null;
  /** Protected transport outcome, including missing/admission reasons. */
  decision?: Pick<DecisionResult, 'key' | 'status' | 'reason' | 'failureCause'>;
}
export interface AtomicFeedback {
  failed_check_count: number; omitted_failed_checks: number;
  failed_checks: { template: string; unit: string; probability: number | null }[];
}
export interface AtomicGradeResult {
  schema: 'paideia.atomic-grade.v1'; status: 'pass' | 'fail' | 'unknown' | 'error';
  /** Null when admission prevented a measurement; aggregate components remain diagnostic. */
  score: number | null; coverage: number; criticalGate: number; obligationCoverage: number; quality: number;
  failure?: { cause: 'spend-cap'; reason: string };
  identity: { definitionDigest: string; templatesDigest: string; outputDigest: string; contextDigest: string };
  checks: AtomicCheckScore[]; extraction: AtomicExtraction; receipts: DecisionRequestReceipt[];
  feedback: AtomicFeedback; judgeCalls: JudgeCall[];
}
