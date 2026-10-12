import { expect, it } from 'vitest';
import { validateTrainingConfiguration } from './index.js';

const models = { reflect: { provider: 'ollama', model: 'local' } };
const optimizer = { model: 'reflect', variants: 4, keep: 2, budget: { rounds: 3 } };

it('accepts population controls and preserves boundaries verbatim', () => {
  const training = { models, optimizer: { ...optimizer, method: 'gepa', selection: 'pareto',
    boundaries: [' Keep identity. ', 'Never expose secrets.'], patience: 2,
    proposal: { rewrite_share: 0.5, hypothesis_similarity: 0.6, min_change: 0.08 } } };
  expect(validateTrainingConfiguration(training)).toEqual(training);
  expect(validateTrainingConfiguration({ models, optimizer })).toMatchObject({ optimizer });
  expect(validateTrainingConfiguration({ models, optimizer: { ...optimizer, selection: 'top-k', boundaries: [],
    proposal: { rewrite_share: 0, hypothesis_similarity: 1, min_change: 0 } } })).toBeDefined();
});

it.each([
  [{ keep: 5 }, 'optimizer.keep'], [{ keep: undefined }, 'optimizer.keep'],
  [{ budget: undefined }, 'optimizer.budget.rounds'], [{ budget: {} }, 'optimizer.budget.rounds'],
  [{ budget: { rounds: 0 } }, 'optimizer.budget.rounds'],
  [{ budget: { rounds: 1, extra: true } }, 'optimizer.budget.extra'],
  [{ method: 'other' }, 'optimizer.method'], [{ variants: 1.5 }, 'optimizer.variants'],
  [{ selection: 'random' }, 'optimizer.selection'], [{ patience: 0 }, 'optimizer.patience'],
  [{ boundaries: 'text' }, 'optimizer.boundaries'], [{ boundaries: [''] }, 'optimizer.boundaries[0]'],
  [{ boundaries: ['x'.repeat(501)] }, 'optimizer.boundaries[0]'],
  [{ boundaries: Array(51).fill('boundary') }, 'optimizer.boundaries'],
  [{ proposal: { rewrite_share: -0.1 } }, 'proposal.rewrite_share'],
  [{ proposal: { hypothesis_similarity: 1.1 } }, 'proposal.hypothesis_similarity'],
  [{ surprise: 1 }, 'optimizer.surprise'],
])('names invalid population fields %j', (override, reason) => {
  expect(() => validateTrainingConfiguration({ models, optimizer: { ...optimizer, ...override } })).toThrow(reason);
});

it('rejects a declared cap unable to fund keep plus variants', () => {
  expect(() => validateTrainingConfiguration({ models, optimizer, budget: { max_proposals: 5 } }))
    .toThrow('budget.max_proposals');
  expect(validateTrainingConfiguration({ models, optimizer, budget: { max_proposals: 6 } })).toBeDefined();
});
