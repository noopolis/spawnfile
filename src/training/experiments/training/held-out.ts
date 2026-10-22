import { testRepeatCount } from '../../contracts/training-config.js';
import type { CandidateManifest } from '../../candidates/index.js';
import type { TrialReport } from '../trials/index.js';

export interface HeldOutScore {
  candidateId: string;
  meanScore: number;
  trialIds: string[];
  evaluationIds?: string[];
  /** Aligned with trialIds/evaluationIds; present only for repeated tests to preserve single-pass report bytes. */
  trialScores?: number[];
  /** Sample standard deviation / sqrt(n); null when n < 2. Descriptive only. */
  standardError?: number | null;
}

/** Run only frozen candidates, bounded by provisioned concurrency; drain on failure. */
export async function evaluateHeldOut(options: {
  candidates: readonly CandidateManifest[];
  caseIds: readonly string[];
  concurrency: number;
  testRepeats?: number;
  trial(candidate: CandidateManifest, caseId: string, repeat: number): Promise<TrialReport>;
  measurement(report: TrialReport): { id: string; score: number };
}): Promise<HeldOutScore[]> {
  const repeats = testRepeatCount(options.testRepeats);
  const jobs = options.candidates.flatMap(candidate => options.caseIds.flatMap(caseId =>
    Array.from({ length: repeats }, (_, repeat) => ({ candidate, caseId, repeat }))));
  const reports: TrialReport[] = new Array(jobs.length);
  const measurements: { id: string; score: number }[] = new Array(jobs.length);
  let next = 0, failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < jobs.length) {
      const index = next++;
      const job = jobs[index]!;
      try {
        reports[index] = await options.trial(job.candidate, job.caseId, job.repeat);
        measurements[index] = options.measurement(reports[index]!);
      }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
  if (failed) throw failure;
  const batchSize = options.caseIds.length * repeats;
  return options.candidates.map((candidate, index) => {
    const batch = reports.slice(index * batchSize, (index + 1) * batchSize);
    const measured = measurements.slice(index * batchSize, (index + 1) * batchSize);
    const trialScores = measured.map(item => item.score);
    const meanScore = trialScores.reduce((sum, score) => sum + score, 0) / batch.length;
    const standardError = batch.length < 2 ? null
      : Math.sqrt(trialScores.reduce((sum, score) => sum + (score - meanScore) ** 2, 0) / (batch.length - 1) / batch.length);
    return { candidateId: candidate.id, meanScore,
      trialIds: batch.map(report => report.id), evaluationIds: measured.map(item => item.id),
      ...(repeats === 1 ? {} : { trialScores, standardError }) };
  });
}
