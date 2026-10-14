import { expect, it } from 'vitest';
import { parseDatasetYaml, resolveDataset } from './index.js';
import { projectDatasetCost } from './cost-projection.js';
import { validateDatasetSplit, validateCostDatasetSplit } from './splits.js';

function dataset(id: string, lineage?: string[]) {
  return resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'paideia.dataset.v1', id, checks: [{ id: 'ok', eval: 'equals', input: 'output.text', value: 'OK' }],
    records: [{ id, group: id, ...(lineage ? { lineage } : {}), input: { prompt: 'Do work.' } }] })));
}
it('preserves lineage in executable and cost projections and refuses shared ancestors across every role', () => {
  const train = dataset('train', ['source']), validation = dataset('validation', ['validation-source']), test = dataset('test', ['test-source']);
  expect(() => validateDatasetSplit(train, test, validation)).not.toThrow();
  expect(projectDatasetCost(train).records[0]!.lineage).toEqual(['source']);
  for (const candidate of [validation, test]) {
    candidate.records[0]!.lineage = ['source'];
    expect(() => validateDatasetSplit(train, test, validation)).toThrow('lineage leakage');
    expect(() => validateCostDatasetSplit(projectDatasetCost(train), projectDatasetCost(test), projectDatasetCost(validation))).toThrow('lineage leakage');
    candidate.records[0]!.lineage = [candidate.id];
  }
});
it('rejects malformed empty or duplicate ancestor declarations before resolution', () => {
  for (const lineage of [[], ['one', 'one'], [null], ['']]) expect(() => dataset('train', lineage as string[])).toThrow();
});
