import { expect, it } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { freezeCriteria } from './criteria.js';
import type { JudgeRoute } from '../../contracts/evaluation.js';

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


it('freezes evidence-ID protocol before sidecar awaits and preserves it through engine execution', async () => {
  const { evaluateNode } = await import('../../evaluation/index.js');
  const { evaluationContext } = await import('../../testing/index.js');
  const route: JudgeRoute = { model: 'fixed', protocol: 'evidence-ids', provider: { id: 'fixture',
    capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false },
    async generate(request) {
      expect(request.model).toBe('fixed');
      expect(request.responseSchema).toMatchObject({ required: ['score', 'verdict', 'reasons', 'evidenceIds'] });
      const packet = JSON.parse(request.prompt.split('SOURCE DATA\n')[1]!) as { units: { id: string }[] };
      return { text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Supported.'], evidenceIds: [packet.units[0]!.id] }),
        model: request.model, route: 'fixture', usage: null };
    } } };
  const dataset = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: protocol
checks: [{id: quality, eval: llm-rubric, input: output.text, judge: editor, rubric: {file: rubric.md}, minimum: 0.8}]
records: [{id: train, input: {prompt: Reply}}]
`), { registry: { judges: { editor: { version: 'fixed' } } }, readCriterionFile: () => 'Fixed rubric' });
  const registry = createEvaluationRegistry();
  const frozen = await freezeCriteria(dataset, { judges: { editor: route }, embeddings: {}, readText: async () => {
    route.protocol = 'citations'; route.model = 'changed'; return 'Fixed rubric';
  } }, registry);
  expect(frozen.judges.editor).toMatchObject({ protocol: 'evidence-ids', model: 'fixed' });
  const measured = await evaluateNode(dataset.records[0]!.effectiveStages[0]!.checks[0]!, evaluationContext(frozen), registry);
  expect(measured).toMatchObject({ status: 'pass', score: 0.9 });
});
