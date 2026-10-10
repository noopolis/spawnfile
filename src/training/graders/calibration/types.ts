export type QuestionType = 'yes-no' | 'choice' | 'score';
export type GoldenSource = 'human' | 'consensus' | 'single-teacher';
export interface CalibrationRecord {
  questionId: string;
  type: QuestionType;
  group: string;
  example?: { dataset: string; id: string };
  /** Missing decisions retain the golden denominator; rawPGood is ignored. */
  missing?: boolean;
  rawPGood: number;
  good: boolean;
  source: GoldenSource;
}
export interface Exclusions {
  lineages?: readonly string[];
  examples?: readonly { dataset: string; id: string }[];
}
export interface PlattParams { a: number; b: number }
export interface PlattFit extends PlattParams { converged: boolean; iterations: number }
export interface ScoredRecord extends CalibrationRecord { p: number }
export interface EvidenceCounts { groups: number; instances: number; good: number; bad: number }
export type Interval = [number, number];
export interface CalibrationMetrics extends EvidenceCounts {
  baseRate: number;
  accuracy: number;
  brier: number;
  baseRateBrier: number;
  ece: number;
  eceInterval: Interval;
  brierInterval: Interval;
  falsePassRate?: number;
  falsePassInterval?: Interval;
}
export type CalibrationStatus = 'calibrated' | 'insufficient-evidence' | 'uncalibrated' | 'escalation-infeasible' | 'unverified';
export interface BarResult { status: CalibrationStatus; failures: string[] }
export interface QuestionCalibration extends BarResult {
  questionId: string;
  params: PlattParams;
  fitSource: 'question' | 'type';
  fitGroups: number;
  metrics: CalibrationMetrics;
  bySource: Partial<Record<GoldenSource, CalibrationMetrics>>;
  interpretation: 'human-adjudicated and teacher agreement' | 'teacher agreement, not validated correctness';
}
