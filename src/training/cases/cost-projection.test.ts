import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { parseDatasetYaml, resolveDataset, resolveDatasetForCost, validateCostDatasetSplit } from './index.js';
import type { ResolvedDataset, ResolvedRecord } from '../contracts/dataset.js';

const source = `schema: paideia.dataset.v1
id: cost
setup: {profile: custom/preparation, artifacts: {article: {kind: captured}}}
checks: [{id: prose, eval: llm-rubric, judge: prose, input: 'artifact:article', minimum: 0.8, rubric: {file: rubric.md}}]
fixtures:
  task: {input: {prompt: Write}, setup: {date: {context: date}}}
records:
- id: first
  group: a
  use: [task]
  context: {date: today}
- id: second
  group: b
  use: [task]
  context: {date: yesterday}
`;
const options = { requireGroups: true, registry: { judges: { prose: { version: 'judge.v1' } } }, readCriterionFile: () => 'Write clearly.' };

describe('non-executable cost dataset projection', () => {
  it('preserves artifact checks and fixture resolution without claiming plugin availability or invoking validators', () => {
    const validate = vi.fn(() => { throw Error('Must not invoke preparation'); });
    const document = parseDatasetYaml(source);
    const resolved = resolveDatasetForCost(document, { ...options, registry: { ...options.registry,
      preparations: { 'custom/preparation': { version: 'v1', unlockedPaths: [], validate } } } });
    expect(validate).not.toHaveBeenCalled();
    expect(resolved.preparation).toEqual({ status: 'unverified', profiles: ['custom/preparation'], checks: ['availability', 'locks', 'parameter-semantics'] });
    expect(resolved.records).toHaveLength(2);
    expect(resolved.records[0]!.costChecks[0]!.check).toMatchObject({ id: 'prose', judge: 'prose', input: 'artifact:article' });
    expect(Object.keys(resolved.records[0]!).sort()).toEqual(['costChecks', 'group', 'id', 'schema', 'selectedFiles']);
    expect(resolved).not.toHaveProperty('sharedPlanDigest');
    expect(resolved).not.toHaveProperty('registryVersions');
    expectTypeOf(resolved).not.toExtend<ResolvedDataset>();
    expectTypeOf(resolved.records[0]!).not.toExtend<ResolvedRecord>();
    expect(() => resolveDataset(document, options)).toThrow('unsupported preparation');
    expect(() => resolveDataset(document, { ...options, registry: { ...options.registry,
      preparations: { 'custom/preparation': { version: 'v1', unlockedPaths: [], validate } } } })).toThrow('locked');
  });
  it.each([
    [source.replace('use: [task]', 'use: [missing]'), 'unknown fixture'],
    [source.replace('date: today', 'date: {context: missing}'), 'missing context'],
    [source.replace('setup: {date:', 'setup: {profile: other, date:'), 'locked preparation'],
    [source.replace('input: \'artifact:article\'', 'input: \'artifact:missing\''), 'artifact'],
    [source.replace('judge: prose', 'judge: missing'), 'judge'],
    [source.replace('group: a', 'extra: nope'), 'unknown field'],
    [source.replace('input: {prompt: Write}', 'input: {prompt: Write, data: {binding: missing.value}}'), 'binding'],
  ])('retains structural rejection: %s', (text, message) => {
    expect(() => resolveDatasetForCost(parseDatasetYaml(text), options)).toThrow(message);
  });
  it('projects multi-turn inputs only into their cost checks and source identities', () => {
    const document = parseDatasetYaml(JSON.stringify({ schema: 'paideia.dataset.v1', id: 'turns',
      checks: [{ id: 'done', eval: 'equals', input: 'output.text', value: 'OK' }],
      records: [{ id: 'one', group: 'g', turns: [{ id: 'first', input: { prompt: 'Never expose this input' } },
        { id: 'second', input: { prompt: 'Continue' }, checks: [{ id: 'turn-done', eval: 'equals', input: 'output.text', value: 'OK' }] }] }] }));
    const cost = resolveDatasetForCost(document);
    expect(cost.records[0]!.costChecks.filter(({ check }) => check.eval)).toHaveLength(2);
    expect(JSON.stringify(cost)).not.toContain('Never expose');
    expect(cost.preparation.profiles).toEqual([]);
  });
  it('authenticates rubric structure and rejects split overlap and drift', () => {
    const train = resolveDatasetForCost(parseDatasetYaml(source), options);
    const test = resolveDatasetForCost(parseDatasetYaml(source.replaceAll('first', 'third').replaceAll('second', 'fourth').replace('group: a', 'group: x').replace('group: b', 'group: y')), options);
    expect(() => validateCostDatasetSplit(train, test)).not.toThrow();
    test.records[0]!.group = 'a'; expect(() => validateCostDatasetSplit(train, test)).toThrow('leakage');
    test.records[0]!.group = 'x'; test.structureDigest = 'changed';
    expect(() => validateCostDatasetSplit(train, test)).toThrow('plan drift');
    expect(() => resolveDatasetForCost(parseDatasetYaml(source), { ...options, readCriterionFile: undefined })).toThrow();
  });
});
