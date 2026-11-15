import { describe, expect, it } from 'vitest';
import { testBankYaml } from '../questionnaire/testSupport.js';
import { parseDatasetYaml, resolveDataset } from './index.js';

const resolve = (check: Record<string, unknown>, bank = testBankYaml, judges: Record<string, { version: string }> = { strong: { version: '1' } }) =>
  resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'spawnfile.training.dataset.v1', id: 'd',
    checks: [{ id: 'house', eval: 'questionnaire', bank: 'bank.yaml', input: 'artifact:article', context: { evidence: 'context:evidence', assignment: 'artifact:brief' }, ...check }],
    records: [{ id: 'r', input: { prompt: 'Write' }, outputs: { article: 'article.json', brief: 'brief.txt' }, context: { evidence: [] } }],
  }), { sourceName: '/project/dataset.yaml' }), { readCriterionFile: () => bank, registry: { judges } });

describe('questionnaire check resolution', () => {
  it('freezes the bank bytes and its judge routes', () => {
    const dataset = resolve({});
    expect(dataset.criterionFileDigests['bank.yaml']).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(dataset.registryVersions).toMatchObject({ 'evaluator:questionnaire': '1', 'judge:strong': '1' });
  });
  it.each([
    [{ bank: '../bank.yaml' }, /contained relative path/u],
    [{ input: 'output.text' }, /artifact selector/u],
    [{ context: { evidence: 'input:files', assignment: 'context:a' } }, /unsupported questionnaire context selector/u],
    [{ context: { evidence: 'context:evidence' } }, /unbound questionnaire context assignment/u],
    [{ context: { evidence: 'context:evidence', assignment: 'context:a', extra: 'context:b' } }, /unknown questionnaire context extra/u],
    [{ threshold: 1 }, /unknown field/u],
  ])('refuses %j', (check, message) => {
    expect(() => resolve(check)).toThrow(message);
  });
  it('refuses an invalid bank and an undeclared judge route', () => {
    expect(() => resolve({}, testBankYaml.replace('pass: yes', 'pass: maybe'))).toThrow(/bank/u);
    expect(() => resolve({}, 'not: [valid')).toThrow(/bank/u);
    expect(() => resolve({}, testBankYaml, {})).toThrow(/unresolved judge route strong/u);
  });
});
