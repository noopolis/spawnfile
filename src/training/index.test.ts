import { expect, it } from 'vitest';
import { createEvaluationRegistry, evaluatePlan, parseDatasetYaml, resolveDataset } from './public.js';
import { evaluationContext, snapshot } from './testing/index.js';

it('resolves and evaluates authored cases through the training public entry point', async () => {
  const dataset = resolveDataset(parseDatasetYaml(`schema: spawnfile.training.dataset.v1
id: public-entry
checks:
  - {id: answer, eval: equals, input: output.text, value: '4'}
records:
  - {id: record, input: {prompt: What is two plus two?}}
`));
  const stages = dataset.records[0]!.effectiveStages;
  const registry = createEvaluationRegistry();
  expect((await evaluatePlan(stages, evaluationContext(), registry)).status).toBe('pass');
  expect((await evaluatePlan(stages, evaluationContext({ snapshot: snapshot({ output: 'incorrect' }) }), registry)).status).toBe('fail');
});
