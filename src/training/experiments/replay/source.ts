import { createHash } from 'node:crypto';
import { captureObservation } from '../../capture/index.js';
import type { TrialReport } from '../trials/index.js';
import type { Replay, StoredEvaluation } from '../../storage/index.js';
import { trialReportSchema } from './schema.js';

export function capturedTrial(replay: Replay): { report: TrialReport; source: StoredEvaluation } {
  if (replay.completeness !== 'complete' || replay.ignoredTailBytes !== 0) throw new Error('Cannot rescore a capture with a truncated journal tail');
  const sources = replay.evaluations.filter(entry => entry.report !== null && typeof entry.report === 'object' &&
    'schema' in entry.report && entry.report.schema === 'paideia.trial.v1');
  if (sources.length !== 1) throw new Error('Rescore requires exactly one accessible original trial report');
  const source = sources[0]!;
  const report = trialReportSchema.parse(source.report);
  const manifest = replay.manifest;
  if (report.id !== manifest.id || report.phase !== manifest.datasetRole || report.candidateId !== manifest.candidateId ||
    report.planDigest !== manifest.planDigest || report.recordId !== manifest.recordId ||
    report.snapshot.trialId !== report.id || report.snapshot.recordId !== report.recordId) {
    throw new Error('Stored trial identity does not match its immutable manifest');
  }
  let events: TrialReport['snapshot']['events'] = [];
  for (const event of report.snapshot.events) {
    if (event.trialId !== report.id) throw new Error('Stored observation belongs to another trial');
    const next = captureObservation(events, event);
    if (next.length === events.length) throw new Error('Stored snapshot contains duplicate observations');
    events = next;
  }
  for (const artifact of Object.values(report.snapshot.artifacts)) {
    if (`sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}` !== artifact.digest) throw new Error('Stored artifact digest mismatch');
  }
  return { report, source };
}
