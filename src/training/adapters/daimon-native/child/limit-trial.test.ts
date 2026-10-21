import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { nativeDeferredTrial } from './deferred-trial.js';
import { trialScore } from '../../../experiments/index.js';

vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/**
 * The run52 abort, through the real child and loopback protocol: the subject ran
 * out of the timeout it declared, the broker sealed that on the closed execution's
 * own usage row, and the stop proved the runtime quiet. That is the candidate's
 * outcome, graded on what it left, and never an infrastructure failure.
 */
it.each(['limit', 'limit-retried'])('grades a sealed declared-limit stop (%s) as the subject outcome and keeps the experiment scoring', async mode => {
  const { report, turn, deliveries, root } = await nativeDeferredTrial(mode);
  roots.push(root);
  expect(deliveries).toBe(0);
  expect(turn).toMatchObject({ status: 'failed', limit: 'timeout' });
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', evidenced: 'task' });
  expect(report.stop?.unevidenced).toBeUndefined();
  expect(report).toMatchObject({ execution: 'limit-exceeded', limit: 'timeout', status: 'fail' });
  expect(report).not.toHaveProperty('failureKind');
  // The article that never appeared fails its check instead of staying unmeasured;
  // partial tool coverage still cannot prove the filing call absent.
  const stage = report.evaluation.stages[0]!;
  expect(stage.checks.map(check => [check.id, check.status])).toEqual([['filed', 'unknown'], ['body', 'fail']]);
  expect(stage.score).toMatchObject({ assessedWeight: 0.5, missingWeight: 0.5, lower: 0 });
  expect(trialScore(report)).toBe(0);
});

it.each([
  ['limit-unlabelled', { unevidenced: 'terminal-unbound' }],
  ['limit-unbacked', { unevidenced: 'terminal-unbound' }],
  // A timeout label on a turn far short of the configured wake ceiling is the idle watchdog: a hang.
  ['limit-idle', { unevidenced: 'terminal-unbound' }],
  ['limit-stop-unknown', { quiescence: 'unknown' }],
])('keeps a %s failure an infrastructure error', async (mode, stop) => {
  const { report, root } = await nativeDeferredTrial(mode);
  roots.push(root);
  expect(report.execution).toBe('failed');
  expect(report).not.toHaveProperty('limit');
  expect(report.stop).toMatchObject(stop);
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});
