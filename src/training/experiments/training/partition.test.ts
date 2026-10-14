import { expect, it } from 'vitest';
import { partitionTraining, resolveTrainingPartitions } from './partition.js';
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

it('retains explicit validation without repartitioning and rejects competing selection controls', () => {
  const train = { id: 'authored', records: [{ group: 'one' }] };
  const validation = { id: 'validation', records: [{ group: 'two' }] };
  expect(resolveTrainingPartitions(train, validation)).toEqual({ train, validation });
  expect(() => resolveTrainingPartitions(train, validation, ['one'])).toThrow('mutually exclusive');
  expect(resolveTrainingPartitions({ ...train, records: [{ group: 'one' }, { group: 'two' }] }).validation.records).toEqual([{ group: 'two' }]);
});
