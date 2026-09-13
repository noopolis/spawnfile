import { expect, it } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { freezeCriteria } from './criteria.js';

it('authenticates and freezes sidecars and evaluator versions before inference', async () => {
  const source = `schema: paideia.dataset.v1
id: checks
checks: [{id: format, eval: json-schema, input: output.text, schema: shape.json}]
records: [{id: one, group: a, input: {prompt: do it}}]
`;
  const dataset = resolveDataset(parseDatasetYaml(source), { readCriterionFile: () => '{"type":"string"}' });
  let bytes = '{"type":"string"}';
  const evaluation = { judges: {}, embeddings: {}, readText: async () => bytes };
  const frozen = await freezeCriteria(dataset, evaluation, createEvaluationRegistry());
  bytes = 'changed'; expect(await frozen.readText('shape.json')).toBe('{"type":"string"}');
  await expect(frozen.readText('undeclared')).rejects.toThrow('Unfrozen');
  await expect(freezeCriteria(dataset, evaluation, createEvaluationRegistry())).rejects.toThrow('changed');
  await expect(freezeCriteria(dataset, evaluation, {})).rejects.toThrow('version drift');
});

it.each([0, 1] as const)('freezes judge model and repair policy (%i) before sidecar awaits', async citationRepairs => {
  const { evaluateNode } = await import('../../evaluation/index.js');
  const { evaluationContext } = await import('../../testing/index.js');
  const replies = [JSON.stringify({ score: 0.2, verdict: 'fail', reasons: ['Keep this verdict'],
    citations: [{ source: 'input', quote: 'absent' }] }), JSON.stringify({ citations: [{ source: 'input', quote: '4' }] })];
  const models: string[] = [];
  const route = { model: 'original', citationRepairs, provider: { id: 'test',
    capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, temperature: false as const, seed: false as const },
    async generate(request: { model: string }) { models.push(request.model); return { text: replies.shift()!, model: 'actual', usage: null, route: 'test' }; } } };
  const source = `schema: paideia.dataset.v1
id: checks
checks: [{id: prose, eval: llm-rubric, input: output.text, judge: editor, rubric: {file: rubric.md}, minimum: 0.8}]
records: [{id: one, input: {prompt: do it}}]
`;
  const dataset = resolveDataset(parseDatasetYaml(source), { registry: { judges: { editor: { version: '1' } } }, readCriterionFile: () => 'Fixed' });
  const observed: string[] = [];
  const evaluation = { judges: { editor: route }, embeddings: {}, observeJudgeAttempt: () => { observed.push('called'); },
    readText: async () => { route.model = 'mutated'; route.citationRepairs = citationRepairs === 1 ? 0 : 1; return 'Fixed'; } };
  const registry = createEvaluationRegistry();
  const frozen = await freezeCriteria(dataset, evaluation, registry);
  expect(frozen.judges.editor!.provider).toBe(route.provider);
  const result = await evaluateNode(dataset.records[0]!.effectiveStages[0]!.checks[0]!, evaluationContext(frozen), registry);
  expect(models).toEqual(Array(citationRepairs + 1).fill('original'));
  expect(observed).toHaveLength(citationRepairs + 1);
  expect(result.status).toBe(citationRepairs === 1 ? 'fail' : 'error');
});
