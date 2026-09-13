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
