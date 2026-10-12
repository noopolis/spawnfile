import { expect, it, vi } from 'vitest';
import { assertBoundaries, compileBoundaries } from './boundaries.js';
import { DspyHost } from './host.js';
import { simulatedOptions } from './testSupport.js';
import { DSPY_SCHEMA, startSchema } from './protocol.js';

const seed = { guide: 'Required rule.', contract: 'Use schema v1.\n' };
const declarations = ['require-text ["guide", "Required rule."]',
  'forbid-text ["guide", "Forbidden."]', 'preserve ["contract"]'];

it('admits real changes while enforcing all exact component text constraints', () => {
  const rules = compileBoundaries(declarations, seed);
  expect(() => assertBoundaries(rules, { ...seed, guide: 'Required rule. Compare independent sources.' })).not.toThrow();
  for (const components of [{}, { ...seed, guide: 'required rule.' },
    { ...seed, guide: 'Required rule. Forbidden.' }, { ...seed, contract: 'Use schema v2.\n' }]) {
    expect(() => assertBoundaries(rules, components)).toThrow('violates hard boundary');
  }
});

it.each(['preserve ["guide"]\n', 'Never publish unverified claims.', 'preserve [', 'preserve [invalid]', 'preserve ["missing"]',
  'preserve ["guide", "extra"]', 'preserve [null]', 'require-text ["guide"]',
  'require-text ["guide", ""]', 'require-text ["guide", 1]', 'preserve {"component":"guide"}'])(
'fails closed on invalid or unenforceable declaration %s', declaration => {
  expect(() => compileBoundaries([declaration], seed)).toThrow('Unsupported hard boundary');
});

it.each(['require-text ["guide", "Absent rule."]', 'forbid-text ["guide", "Required rule."]'])(
'refuses an invalid seed: %s', declaration => {
  expect(() => compileBoundaries([declaration], seed)).toThrow('violates hard boundary');
});

it('host rejects bypassed bridge admission before invoking native evaluation', async () => {
  const { options } = simulatedOptions();
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: options.id,
    components: seed, trainCaseIds: options.trainCaseIds, validationCaseIds: options.validationCaseIds,
    budget: options.budget });
  start.search = { variants: 1, keep: 1, rounds: 1, selection: 'pareto', rewriteShare: 0.5,
    minChange: 0.08, hypothesisSimilarity: 0.6, patience: 1, boundaries: declarations };
  options.validateComponents = vi.fn();
  options.evaluate = vi.fn();
  const host = new DspyHost(start, options);
  await expect(host.handle({ schema: DSPY_SCHEMA, kind: 'request', id: 'bad', method: 'evaluate',
    params: { caseId: start.trainCaseIds[0]!, split: 'train',
      components: { ...seed, guide: 'Required rule. Forbidden.' } } },
    new AbortController().signal)).rejects.toThrow('violates hard boundary');
  expect(options.validateComponents).not.toHaveBeenCalled();
  expect(options.evaluate).not.toHaveBeenCalled();
  expect(host.evaluations).toBe(0);
  await expect(host.validate({ ...seed, guide: 'Required rule. Gather independent evidence.' },
    new AbortController().signal)).resolves.toBeUndefined();
  expect(options.validateComponents).toHaveBeenCalledTimes(1);
});
