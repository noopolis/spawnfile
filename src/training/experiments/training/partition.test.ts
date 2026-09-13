import { expect, it } from 'vitest';
import { partitionTraining } from './partition.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';

it('freezes a group-disjoint validation partition without a third required YAML', () => {
  const dataset = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: training
checks: [{id: done, eval: equals, input: output.text, value: ok}]
records:
  - {id: one, group: a, input: {prompt: one}}
  - {id: two, group: b, input: {prompt: two}}
  - {id: three, group: b, input: {prompt: three}}
`));
  const automatic = partitionTraining(dataset);
  expect(automatic.train.records.map(record => record.id)).toEqual(['one']);
  expect(automatic.validation.records.map(record => record.id)).toEqual(['two', 'three']);
  expect(partitionTraining(dataset, ['a']).train.records).toHaveLength(2);
  for (const groups of [[], ['missing'], ['a', 'a'], ['a', 'b']]) expect(() => partitionTraining(dataset, groups)).toThrow();
  expect(() => partitionTraining({ ...dataset, records: dataset.records.slice(0, 1) })).toThrow('at least two');
  expect(() => partitionTraining({ ...dataset, records: dataset.records.map(record => ({ ...record, group: undefined })) })).toThrow();
  expect(dataset.records).toHaveLength(3);
});
