import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

it('surfaces missing provider composition from the provider refinement', async () => {
  const { provider } = await import('./common.js');
  expect(() => provider.parse('claude')).toThrow(new Error('Grader provider registry is not configured'));
});

it('surfaces missing provider composition from public grader parsing', async () => {
  const { parseGrader } = await import('./index.js');
  expect(() => parseGrader({
    schema: 'spawnfile.training.grader.v1', id: 'writing', golden: 'labels.yaml', calibration: 'calibration.json',
    teachers: [{ id: 'teacher', provider: 'claude', model: 'chosen' }],
    model: { backend: 'teacher', teacher: 'teacher' }, escalate: { to: 'teacher', between: [0.3, 0.7] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }],
    score: { method: 'weighted' },
  })).toThrow(new Error('Grader provider registry is not configured'));
});
