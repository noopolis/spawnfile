import type { CandidateManifest } from '../../candidates/index.js';
import type { TrialReport } from '../trials/index.js';

export interface HeldOutScore {
  candidateId: string;
  meanScore: number;
  trialIds: string[];
  evaluationIds: string[];
}

/** Run only frozen candidates, bounded by provisioned concurrency; drain on failure. */
export async function evaluateHeldOut(options: {
  candidates: readonly CandidateManifest[];
  caseIds: readonly string[];
  concurrency: number;
  trial(candidate: CandidateManifest, caseId: string): Promise<TrialReport>;
  measurement(report: TrialReport): { id: string; score: number };
}): Promise<HeldOutScore[]> {
  const jobs = options.candidates.flatMap(candidate => options.caseIds.map(caseId => ({ candidate, caseId })));
  const reports: TrialReport[] = new Array(jobs.length);
  const measurements: { id: string; score: number }[] = new Array(jobs.length);
  let next = 0, failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < jobs.length) {
      const index = next++;
      const job = jobs[index]!;
      try {
        reports[index] = await options.trial(job.candidate, job.caseId);
        measurements[index] = options.measurement(reports[index]!);
      }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
  if (failed) throw failure;
  return options.candidates.map((candidate, index) => {
    const batch = reports.slice(index * options.caseIds.length, (index + 1) * options.caseIds.length);
    const measured = measurements.slice(index * options.caseIds.length, (index + 1) * options.caseIds.length);
    return { candidateId: candidate.id, meanScore: measured.reduce((sum, item) => sum + item.score, 0) / batch.length,
      trialIds: batch.map(report => report.id), evaluationIds: measured.map(item => item.id) };
  });
}
