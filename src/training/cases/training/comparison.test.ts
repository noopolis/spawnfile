import { expect, it } from 'vitest';
import { validateTrainingConfiguration } from './schema.js';
const config = () => ({ models: { judge: { provider: 'grok-subscription', model: 'm' } },
  comparison: { candidate: { name: 'Authored', replacements: [{ resource: 'agent/AGENTS.md', source: 'variant/AGENTS.md' }] } } });
it('accepts strictly authored comparison configuration', () => {
  expect(validateTrainingConfiguration(config())).toEqual(config());
  expect(validateTrainingConfiguration({ ...config(), budget: { max_trials: 6 } })).toMatchObject({ budget: { max_trials: 6 } });
});
it.each([
  { candidate: { name: '', replacements: [] } }, { extra: true },
  { candidate: { name: ' '.repeat(2), replacements: [{ resource: 'a', source: 'b' }] } },
  { candidate: { name: 'a'.repeat(121), replacements: [{ resource: 'a', source: 'b' }] } },
  { candidate: { name: 'a', replacements: [] } }, { candidate: { name: 'a', replacements: Array(129).fill({ resource:'a', source:'b' }) } },
  { candidate: { name: 'a', replacements: [{ resource:'../a', source:'b' }] } },
  { candidate: { name: 'a', replacements: [{ resource:'a', source:'/outside' }] } },
  { candidate: { name: 'a', replacements: [{ resource:'a', source:'b' },{ resource:'a', source:'c' }] } },
  { candidate: { name: 'a', replacements: [{ resource:'a', source:'b', unknown:true }] } },
])('rejects malformed comparison %j', comparison => {
  expect(() => validateTrainingConfiguration({ ...config(), comparison })).toThrow();
});
it('rejects optimizer route and proposal budget instead of silently ignoring them', () => {
  expect(() => validateTrainingConfiguration({ ...config(), optimizer: { model: 'judge' } })).toThrow('does not run an optimizer');
  expect(() => validateTrainingConfiguration({ ...config(), budget: { max_proposals: 0 } })).toThrow('has no proposals');
});

it('refuses unsupported repeated comparison arms rather than silently running one pass', () => {
  expect(validateTrainingConfiguration({ ...config(), budget: { test_repeats: 1 } }).budget).toEqual({ test_repeats: 1 });
  expect(() => validateTrainingConfiguration({ ...config(), budget: { test_repeats: 3 } })).toThrow('test_repeats');
});
