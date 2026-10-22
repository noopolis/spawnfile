import type { DecisionAccounting, DecisionBackend } from '../../contracts/grading.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { JudgeCall } from '../../contracts/evaluation.js';
import type { Grader } from '../format/index.js';
import type { CalibrationFile } from '../identity.js';
import type { GraderResult, GateOutcome } from '../aggregation.js';

export interface GraderTeacher { provider: InferenceProvider; model: string }
export interface GradingRuntime {
  grader: Grader;
  calibration: CalibrationFile;
  backend: DecisionBackend;
  backends?: Record<string, DecisionBackend>;
  teacher?: GraderTeacher;
  goldenDigest: string;
  promptTemplateVersion: string;
  /** Shared endpoint token: checks using the same backend must serialize. */
  resource: object;
  resources?: object[];
  definitionDigest?: string;
  calibrationDigest?: string;
}
export interface GradeOptions extends GradingRuntime {
  output: unknown;
  context?: Record<string, unknown>;
  gateOutcomes?: Record<string, GateOutcome>;
  signal?: AbortSignal;
}
export interface GradeResult extends GraderResult {
  identity: { calibration: CalibrationFile['identity']; calibrationDigest: string; escalation: string; teacherPolicy: string; scoringPolicy: string };
  backendBilling: 'local' | 'subscription' | 'api' | 'mixed';
  decisions?: { instance: string; model: string; status: 'ok' | 'missing'; reason?: string }[];
  decisionAccounting?: DecisionAccounting;
  judgeCalls: JudgeCall[];
}
