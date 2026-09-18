import { expect, it } from 'vitest';
import { result } from '../../evaluation/index.js';
import { trialScore } from './scoring.js';
import type { TrialReport } from '../trials/index.js';

it('separates quality, incomplete observation and infrastructure outcomes', () => {
  const report = { id: 'trial', status: 'pass', execution: 'completed', hostWork: 'settled', stop: { state: 'acknowledged' },
    evaluation: { stages: [] }, live: [] } as unknown as TrialReport;
  expect(trialScore(report)).toBe(1);
  expect(trialScore({ ...report, status: 'fail' })).toBe(0);
  expect(() => trialScore({ ...report, hostWork: 'incomplete' })).toThrow('infrastructure');
  expect(() => trialScore({ ...report, stop: { state: 'unknown' } as TrialReport['stop'] })).toThrow('infrastructure');
  expect(() => trialScore({ ...report, stop: undefined })).toThrow('infrastructure');
  for (const status of ['unknown', 'error', 'skipped'] as const) expect(() => trialScore({ ...report, status })).toThrow('unscorable');
  expect(() => trialScore({ ...report, execution: 'interrupted' })).toThrow('incomplete');
  const failed = { ...report, status: 'fail' as const, execution: 'interrupted' as const,
    live: [{ checkId: 'advisory', boundary: 'closed', result: result('fail', 'quality') }] };
  expect(() => trialScore(failed)).toThrow('incomplete');
  expect(trialScore({ ...failed, decisiveFailure: result('fail', 'forbidden') })).toBe(0);
  expect(() => trialScore({ ...failed, execution: 'failed', decisiveFailure: result('fail', 'forbidden') })).toThrow('infrastructure');
  // A closed execution whose delivery stayed deferred: scored, never passed, never infrastructure.
  const deferred = { ...report, status: 'fail' as const, execution: 'deferred' as const,
    stop: { state: 'acknowledged', quiescence: 'confirmed' } as TrialReport['stop'] };
  expect(trialScore(deferred)).toBe(0);
  expect(() => trialScore({ ...deferred, status: 'pass' })).toThrow('cannot pass on a deferred delivery');
  expect(() => trialScore({ ...deferred, status: 'unknown' })).toThrow('unscorable');
  // Without the quiescence proof it is an unproven execution again, exactly as before.
  expect(() => trialScore({ ...deferred, stop: { state: 'acknowledged' } as TrialReport['stop'] })).toThrow('incomplete');
  const graded = { ...report, evaluation: { ...report.evaluation, stages: [{ id: 'quality', checks: [], gate: result('pass', 'ok'),
    score: { finality: 'final' as const, lower: 0.8, upper: 0.8, assessedWeight: 1, missingWeight: 0 } }] } };
  expect(trialScore(graded)).toBe(0.8);
  graded.evaluation.stages[0]!.score!.missingWeight = 0.1;
  expect(() => trialScore(graded)).toThrow('coverage');
});
