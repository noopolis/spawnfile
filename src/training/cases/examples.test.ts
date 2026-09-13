import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { DataMap, Dataset, DatasetRegistry, EvaluatorDefinition, ResolvedDataset } from '../contracts/dataset.js';
import { parseDatasetYaml, resolveDataset, selectedFiles, validateDatasetSplit } from './index.js';
import { fields, object, string } from './validation.js';

// Schema-only project descriptors deliberately do not assert runtime support.
function domain(allowed: string[]): EvaluatorDefinition {
  return { version: 'schema-review-v1', kind: 'mechanical', incremental: true, stopProof: true,
    validate(parameters, path) {
      fields(parameters, allowed, path);
      for (const name of allowed) string(parameters[name], `${path}.${name}`);
    } };
}
const registry: DatasetRegistry = {
  evaluators: {
    'newsroom/article-format': domain(['input', 'owner']),
    'newsroom/accepted-history': domain(['owner', 'operation']),
    'newsroom/filing-handoff': domain(['owner', 'recipient']),
    'newsroom/no-direct-research': domain([]),
  },
  judges: { 'editorial-subscription': { version: 'schema-review-judge-v1' } },
  preparations: { 'newsroom/assigned-story': {
    version: 'schema-review-v1', unlockedPaths: ['clock', 'delivery'],
    validate(parameters, path) {
      fields(parameters, ['fidelity', 'resource_views', 'memory', 'isolation', 'artifacts', 'clock', 'delivery'], path);
      const clock = object(parameters.clock, `${path}.clock`);
      fields(clock, ['mode', 'date', 'time', 'timezone'], `${path}.clock`);
      string(clock.date, `${path}.clock.date`);
      const artifacts = parameters.artifacts as DataMap;
      const accepted = artifacts['accepted-article'] as DataMap;
      string(accepted.edition, `${path}.artifacts.accepted-article.edition`);
    },
  } },
};
function newsroom(name: string): ResolvedDataset {
  const sourceName = new URL(`../../examples/newsroom-reporting/evals/${name}.paideia.yaml`, import.meta.url);
  return resolveDataset(parseDatasetYaml(readFileSync(sourceName, 'utf8'), { sourceName: sourceName.pathname }),
    { registry, subject: 'scribe', requireGroups: true, unlockedSetupPaths: ['clock', 'delivery'] });
}
describe('unchanged real newsroom authoring', () => {
  it('resolves both original datasets with identical criteria and unaltered evidence selectors', () => {
    const train = newsroom('train');
    const test = newsroom('test');
    expect(train.records).toHaveLength(2);
    expect(test.records).toHaveLength(1);
    expect(train.sharedPlanDigest).toBe(test.sharedPlanDigest);
    expect(train.records[0]!.setup!.clock).toEqual({ mode: 'emulated', date: '2026-09-12', time: '13:30:00', timezone: 'Europe/Berlin' });
    expect(train.records[0]!.input!.files![1]!.sha256).toBe('sha256:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
    expect(train.records[0]!.reference!.files![0]!.path).toContain('/articles/');
    expect(train.records[0]!.input!.prompt).toMatch(/readers\.\n$/);
    expect(selectedFiles(train.records[0]!)).toHaveLength(4);
    expect(() => validateDatasetSplit(train, test)).not.toThrow();
  });
  it('fails without actual registered project support instead of accepting fake generic execution', () => {
    const source = readFileSync(new URL('../../examples/newsroom-reporting/evals/train.paideia.yaml', import.meta.url), 'utf8');
    expect(() => resolveDataset(parseDatasetYaml(source))).toThrow(/unsupported evaluator/);
  });
});
function simple(id: string, group: string, path: string, digit: string): ResolvedDataset {
  const data: Dataset = { schema: 'paideia.dataset.v1', id, checks: [{ id: 'correct', eval: 'equals', input: 'output.text', value: '4' }],
    records: [{ id, group, input: { prompt: '4', files: [{ resource: 'evidence', path, sha256: `sha256:${digit.repeat(64)}` }] } }] };
  return resolveDataset(parseDatasetYaml(stringify(data)));
}
describe('group and source holdout isolation', () => {
  it('accepts distinct train/validation/test evidence and rejects hidden leakage mutations', () => {
    const train = simple('train', 'family-a', 'a.md', 'a');
    const test = simple('test', 'family-b', 'b.md', 'b');
    const validation = simple('validation', 'family-c', 'c.md', 'c');
    expect(() => validateDatasetSplit(train, test, validation)).not.toThrow();
    for (const mutate of [
      (copy: ResolvedDataset) => { copy.sharedPlanDigest = 'different'; },
      (copy: ResolvedDataset) => { copy.subject = 'other'; },
      (copy: ResolvedDataset) => { delete copy.records[0]!.group; },
      (copy: ResolvedDataset) => { copy.records[0]!.id = 'train'; },
      (copy: ResolvedDataset) => { copy.records[0]!.group = 'family-a'; },
      (copy: ResolvedDataset) => { copy.records[0]!.input!.files![0]!.path = 'a.md'; },
      (copy: ResolvedDataset) => { copy.records[0]!.input!.files![0]!.sha256 = `sha256:${'a'.repeat(64)}`; },
    ]) {
      const altered = structuredClone(test);
      mutate(altered);
      expect(() => validateDatasetSplit(train, altered)).toThrow();
    }
    const sameGroup = structuredClone(train.records[0]!);
    sameGroup.id = 'additional';
    train.records.push(sameGroup);
    expect(() => validateDatasetSplit(train, test)).not.toThrow();
  });
  it('counts later-turn evidence and evaluator references as part of split membership', () => {
    const train = simple('train', 'family-a', 'a.md', 'a');
    const test = simple('test', 'family-b', 'b.md', 'b');
    test.records[0]!.turns = [{ id: 'later', input: { prompt: 'read', files: train.records[0]!.input!.files } }];
    expect(() => validateDatasetSplit(train, test)).toThrow(/overlap/);
    delete test.records[0]!.turns;
    test.records[0]!.reference = { files: train.records[0]!.input!.files };
    expect(() => validateDatasetSplit(train, test)).toThrow(/overlap/);
  });
});

it('rejects input files that expose any selected evaluator-only reference', () => {
  const source = `schema: paideia.dataset.v1
id: leak
checks: [{id: correct, eval: equals, input: output.text, value: answer}]
records:
- id: task
  input:
    prompt: Read
    files: [{resource: evidence, path: answer.txt, sha256: 'sha256:${'a'.repeat(64)}'}]
  reference:
    files: [{resource: evidence, path: answer.txt, sha256: 'sha256:${'a'.repeat(64)}'}]
`;
  expect(() => resolveDataset(parseDatasetYaml(source))).toThrow(/reference material/);
  const renamed = source.replace('reference:\n    files: [{resource: evidence, path: answer.txt', 'reference:\n    files: [{resource: renamed, path: other.txt');
  expect(() => resolveDataset(parseDatasetYaml(renamed))).toThrow(/reference material/);
});
