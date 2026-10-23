import { expect, it } from 'vitest';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { requireMechanicalTurn } from './preflight.js';

it('rejects semantic, ambiguous and unresolved turn dependencies before paid work', () => {
  const registry = createEvaluationRegistry();
  for (const check of [{}, { eval: 'equals', all: [] }, { all: [] }, { score: 'missing' }, { passed: 'missing' },
    { not: { eval: 'llm-rubric' } }, { any: [{ eval: 'embedding-similarity' }] }, { eval: 'missing' }]) {
    expect(() => requireMechanicalTurn([check], registry)).toThrow('mechanical');
  }
  expect(() => requireMechanicalTurn([{ id: 'first', eval: 'equals' }, { score: 'first', at_least: 0.5 },
    { passed: 'first' }, { all: [{ not: { eval: 'tool-called' } }] }], registry)).not.toThrow();
});
