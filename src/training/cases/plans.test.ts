import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { CheckNode, Dataset, DatasetRegistry, EvaluatorDefinition } from '../contracts/dataset.js';
import { parseDatasetYaml, resolveDataset } from './index.js';
import { checkShape } from './check-schema.js';
import { normalizeStages, resolveLive, resolveStages } from './plans.js';

const exact: CheckNode = { id: 'exact', eval: 'equals', input: 'output.text', value: '4' };
const semantic: CheckNode = { id: 'semantic', eval: 'llm-rubric', input: 'output.text', judge: 'judge', rubric: { prompt: 'Grade' }, minimum: 0.8 };
const registry: DatasetRegistry = { judges: { judge: { version: 'judge-v1' } } };
function dataset(extra: Partial<Dataset> = {}): Dataset {
  return { schema: 'paideia.dataset.v1', id: 'sample', checks: [exact], records: [{ id: 'r', input: { prompt: '4' } }], ...extra };
}
function resolve(value: Dataset, configured = registry) {
  return resolveDataset(parseDatasetYaml(stringify(value, { aliasDuplicateObjects: false })), { registry: configured });
}
function custom(kind: EvaluatorDefinition['kind'], incremental = true, stopProof = true): EvaluatorDefinition {
  return { version: '1', kind, incremental, stopProof, validate: () => undefined };
}
describe('evaluation plan resolution', () => {
  it('resolves ordered stages, weights, logical gates and references without weakening checks', () => {
    const result = resolve(dataset({ checks: undefined, stages: [
      { id: 'mechanics', checks: [exact], gate: { passed: 'exact' } },
      { id: 'writing', when: { passed: 'mechanics' }, checks: [semantic], score: { linear: { semantic: 1 } }, gate: { all: [{ passed: 'semantic' }, { score: 'writing', at_least: 0.8 }] } },
    ] }));
    expect(result.records[0]!.effectiveStages).toHaveLength(2);
    expect(result.registryVersions).toEqual({ 'evaluator:equals': '1', 'evaluator:llm-rubric': '1', 'judge:judge': 'judge-v1' });
    expect(normalizeStages({})).toEqual([]);
    expect(resolve(dataset({ records: [{ id: 'r', input: { prompt: '4' }, checks: [{ id: 'local', not: { eval: 'contains-any', input: 'output.text', values: ['bad'] } }] }] })).records[0]!.effectiveStages).toHaveLength(2);
  });
  it.each([
    [{ id: 'a', passed: 'missing' }, /reference/],
    [{ id: 'a', eval: 'unregistered' }, /unsupported evaluator/],
    [{ id: 'a', use: 'unregistered' }, /unsupported ruleset/],
    [{ ...exact, unknown: true }, /unknown field/],
    [{ ...semantic, judge: 'missing' }, /unresolved judge/],
  ] as [CheckNode, RegExp][])('fails unresolved requirements before work', (check, error) => {
    expect(() => resolve(dataset({ checks: [check] }))).toThrow(error);
  });
  it('rejects duplicate IDs, forward dependencies and invalid score memberships', () => {
    expect(() => resolve(dataset({ checks: [exact, exact] }))).toThrow(/duplicate plan ID/);
    expect(() => resolve(dataset({ checks: [{ id: 'a', passed: 'b' }, { ...exact, id: 'b' }] }))).toThrow(/forward/);
    const context = { registry, versions: {} };
    expect(() => resolveStages([{ id: 'a', checks: [exact] }, { id: 'a', checks: [{ ...exact, id: 'b' }] }], context)).toThrow(/duplicate plan ID/);
    expect(() => resolveStages([{ id: 'a', checks: [exact], score: { linear: { absent: 1 } } }], context)).toThrow(/score component/);
  });
  it('expands registered rulesets before semantic/live eligibility and freezes version identity', () => {
    const rules = { ...registry, rulesets: {
      number: { version: '2', expand: (parameters: Readonly<Record<string, unknown>>) => ({ eval: 'equals', input: 'output.text', value: parameters.value }) },
      prose: { version: '3', expand: () => ({ any: [{ not: semantic }, exact] }) },
    } };
    const value = dataset({ checks: [{ id: 'compiled', use: 'number', with: { value: 4 } }] });
    const result = resolve(value, rules);
    expect(result.sharedStages[0]!.checks[0]).toEqual({ id: 'compiled', eval: 'equals', input: 'output.text', value: 4 });
    expect(result.registryVersions['ruleset:number']).toBe('2');
    const changed = resolve(value, { ...rules, rulesets: { ...rules.rulesets, number: { ...rules.rulesets.number, version: '4' } } });
    expect(changed.sharedPlanDigest).not.toBe(result.sharedPlanDigest);
    const live = dataset({ live: { checks: [{ id: 'watch', on: 'event', on_fail: 'stop', use: 'prose' }] } });
    expect(() => resolve(live, rules)).toThrow(/mechanical finality/);
    expect(() => resolve(dataset({ checks: [{ id: 'loop', use: 'loop' }] }), { rulesets: { loop: { version: '1', expand: () => ({ use: 'loop' }) } } })).toThrow(/cycle/);
  });
  it('permits mechanical hard stops and semantic observation, never semantic stop wrappers', () => {
    const mechanical = resolve(dataset({ live: { checks: [{ id: 'watch', on: 'event', on_fail: 'stop', not: { eval: 'tool-called', tool: 'forbidden' } }] } }));
    expect(mechanical.live.checks[0]!.on_fail).toBe('stop');
    expect(resolve(dataset({ live: { checks: [{ ...semantic, id: 'watch', on: 'event' }] } })).live.checks[0]!.on_fail).toBe('continue');
    for (const node of [semantic, { all: [exact, semantic] }, { not: semantic }, { any: [exact, semantic] }]) {
      expect(() => resolve(dataset({ live: { checks: [{ ...node, id: 'watch', on: 'event', on_fail: 'stop' }] } }))).toThrow(/mechanical/);
    }
    expect(() => resolve(dataset({ live: { checks: [{ id: 'watch', passed: 'exact', on: 'event' }] } }))).toThrow(/reference/);
  });
  it('requires incremental and finality support, also through a custom evaluator', () => {
    const live = dataset({ live: { checks: [{ id: 'watch', eval: 'custom', on: 'event', on_fail: 'stop' }] } });
    expect(() => resolve(live, { evaluators: { custom: custom('mechanical', false) } })).toThrow(/incremental/);
    expect(() => resolve(live, { evaluators: { custom: custom('mechanical', true, false) } })).toThrow(/finality/);
    expect(() => resolve(live, { evaluators: { custom: custom('embedding') } })).toThrow(/mechanical/);
    expect(resolve(live, { evaluators: { custom: custom('mechanical') } }).live.checks).toHaveLength(1);
  });
  it('validates declared artifacts for terminal checks, sequence endings and live checkpoints', () => {
    const record = { id: 'r', input: { prompt: '4' }, outputs: { answer: 'answer.json' } };
    const result = resolve(dataset({ checks: [{ ...exact, input: 'artifact:answer#/text' }], records: [record], live: { checks: [{ ...semantic, id: 'watch', on: { artifact: 'answer' } }] } }));
    expect(result.records[0]!.outputs).toEqual({ answer: 'answer.json' });
    expect(() => resolve(dataset({ checks: [{ ...exact, input: 'artifact:missing' }] }))).toThrow(/undeclared artifact/);
    expect(() => resolve(dataset({ live: { checks: [{ ...exact, id: 'watch', on: { artifact: 'missing' } }] } }))).toThrow(/undeclared live artifact/);
    expect(() => resolve(dataset({ checks: [{ id: 'seq', eval: 'tool-sequence', order: 'happens-before', ending_at: { artifact: 'missing', event: 'accepted-call' }, steps: [{ tool: 'file' }] }] }))).toThrow(/undeclared artifact/);
  });
  it('forbids semantic dependencies from gating subsequent external stimuli', () => {
    const value = dataset({ records: [{ id: 'r', turns: [{ id: 'one', input: { prompt: '4' }, checks: [semantic] }] }] });
    expect(() => resolve(value)).toThrow(/later turn/);
    const context = { registry, versions: {} };
    expect(() => resolveStages([{ id: 'turn', checks: [exact], gate: semantic }], context, true)).toThrow(/later work/);
  });
  it('does not let an absent terminal plan become a passing task', () => {
    expect(() => resolve(dataset({ checks: undefined }))).toThrow(/effective terminal check/);
    expect(() => resolveDataset(parseDatasetYaml(stringify(dataset())), { requireGroups: true })).toThrow(/group/);
    expect(() => checkShape({ not: exact }, '$', false, 49)).toThrow(/nesting/);
    expect(() => resolveLive([{ id: 'x', on: 'event', eval: 'equals', input: 'output.text', value: 1 }], { registry: {}, versions: {} })).not.toThrow();
  });
});

describe('immutable criterion files and cyclic gates', () => {
  it('requires protected sidecar bytes and includes their content identity in comparison', () => {
    const data = dataset({ checks: [{ ...semantic, rubric: { file: 'rubric.md' } }] });
    expect(() => resolve(data)).toThrow(/protected bytes/);
    const document = parseDatasetYaml(stringify(data));
    const first = resolveDataset(document, { registry, readCriterionFile: () => 'first rubric' });
    const second = resolveDataset(document, { registry, readCriterionFile: () => Buffer.from('second rubric') });
    expect(first.sharedPlanDigest).not.toBe(second.sharedPlanDigest);
    expect(first.criterionFileDigests['rubric.md']).toMatch(/^sha256:/);
    const schema = dataset({ checks: [{ id: 'schema', eval: 'json-schema', input: 'output.text', schema: 'schema.json' }] });
    expect(resolveDataset(parseDatasetYaml(stringify(schema)), { readCriterionFile: () => '{"type":"string"}' }).criterionFileDigests['schema.json']).toMatch(/^sha256:/);
  });
  it('rejects self-dependent stage gates even through ruleset expansion', () => {
    const data = dataset({ checks: undefined, stages: [{ id: 'stage', checks: [exact], gate: { any: [{ passed: 'stage' }, { passed: 'exact' }] } }] });
    expect(() => resolve(data)).toThrow(/own verdict/);
  });
  it('resolves explicit embedding route versions and rejects missing routes', () => {
    const data = dataset({ checks: [{ id: 'similarity', eval: 'embedding-similarity', input: 'output.text', reference: 'input:files', provider: 'local', model: 'model', metric: 'cosine', calibration: 'v1', minimum: 0.8 }] });
    expect(() => resolve(data)).toThrow(/embedding route/);
    expect(resolve(data, { embeddings: { local: { version: 'v1' } } }).registryVersions['embedding:local']).toBe('v1');
  });
});

it('rejects a semantic inline when condition in the public mechanical-only resolver', () => {
  expect(() => resolveStages([{ id: 'step', when: semantic, checks: [exact] }], { registry, versions: {} }, true)).toThrow(/semantic.*later/);
});

it('rejects deferred runtime binding tokens in evaluation criteria and references', () => {
  const criterion = dataset({ checks: [{ ...exact, value: { binding: 'future.answer' } }] });
  expect(() => resolve(criterion)).toThrow(/earlier turn/);
  const reference = dataset({ records: [{ id: 'r', input: { prompt: '4' }, reference: { labels: { binding: 'future.answer' } } }] });
  expect(() => resolve(reference)).toThrow(/earlier turn/);
});

it('allows repeated check IDs in separately identified turn and terminal namespaces', () => {
  const value = dataset({ records: [{ id: 'r', turns: [
    { id: 'first', input: { prompt: '4' }, checks: [exact] },
    { id: 'second', input: { prompt: '4' }, checks: [exact] },
  ] }] });
  const record = resolve(value).records[0]!;
  expect(record.effectiveStages[0]!.checks[0]!.id).toBe('exact');
  expect(record.turns!.map(turn => [turn.id, turn.checks![0]!.id])).toEqual([['first', 'exact'], ['second', 'exact']]);
});

it('preserves proof capability for repairable mechanical checks without asserting current finality', () => {
  const result = resolve(dataset({ live: { checks: [{ id: 'watch', on: 'event', on_fail: 'stop',
    not: { eval: 'tool-count', tool: 'forbidden', at_least: 1 } }] } }));
  expect(result.live.checks[0]!.on_fail).toBe('stop');
  expect(result.live.checks[0]).not.toHaveProperty('finality');
});

it('rejects deferred bindings before a ruleset can discard the parameter', () => {
  const value = dataset({ checks: [{ id: 'rule', use: 'ignore', with: { discarded: { binding: 'future.answer' } } }] });
  expect(() => resolve(value, { rulesets: { ignore: { version: '1', expand: () => exact } } })).toThrow(/earlier turn/);
});
