export { splitCalibration, fitPlatt, applyPlatt, calibrateQuestions } from './fitting.js';
export { seededRandom, evidenceCounts, expectedCalibrationError, groupBootstrap,
  calibrationMetrics, evidenceFailures, calibrationBars, teacherAgreement } from './metrics.js';
export { inEscalationBand, planEscalation, escalationTeacherReport } from './escalation.js';
export type { QuestionType, GoldenSource, CalibrationRecord, Exclusions, PlattParams, PlattFit,
  ScoredRecord, EvidenceCounts, Interval, CalibrationMetrics, CalibrationStatus, BarResult,
  QuestionCalibration } from './types.js';
export type { TeacherAgreementRecord } from './metrics.js';
export type { EscalationBand, BandPolicy, CascadeRecord, BandPlan, EscalationTeacherReport } from './escalation.js';
