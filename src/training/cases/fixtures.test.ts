import { describe, expect, it } from 'vitest';
import { parseDatasetYaml, resolveDataset } from './index.js';
import { mergeFixtureValues, overlayValues, resolveContext } from './fixtures.js';
import type { DataMap, ResolutionOptions } from '../contracts/dataset.js';

const options: ResolutionOptions = {
  registry: { preparations: { sample: { version: '1', unlockedPaths: ['clock'], validate: parameters => {
    if (typeof (parameters.clock as DataMap).date !== 'string') throw new Error('clock.date must be text');
  } } } },
  unlockedSetupPaths: ['clock'],
};
const base = `schema: paideia.dataset.v1
id: fixtures
setup: {profile: sample, clock: {mode: emulated}}
checks: [{id: correct, eval: equals, input: output.text, value: '4'}]
fixtures:
  defaults: {setup: {clock: {date: {context: edition}}}, input: {prompt: inherited}}
  evidence: {context: {edition: '2026-09-12', article: {id: one}}, input: {data: [1, 2]}}
records:
- id: first
  use: [defaults, evidence]
  input: {prompt: explicit}
- id: second
  use: [defaults, evidence]
`;
describe('named fixture resolution', () => {
  it('resolves typed cross-fixture context after recursive merge; creates independent records', () => {
    const document = parseDatasetYaml(base);
    const resolved = resolveDataset(document, options);
    expect(resolved.records[0]!.input).toEqual({ prompt: 'explicit', data: [1, 2] });
    expect(resolved.records[0]!.setup!.clock).toEqual({ mode: 'emulated', date: '2026-09-12' });
    expect(resolved.records[0]!.fixtureProvenance).toEqual(['defaults', 'evidence']);
    resolved.records[0]!.input!.data = ['changed'];
    expect(resolved.records[1]!.input!.data).toEqual([1, 2]);
    expect(document.dataset.fixtures!.evidence!.input!.data).toEqual([1, 2]);
    expect(resolveContext({ x: { context: 'article.id' } }, { article: { id: 3 } }, '$')).toEqual({ x: 3 });
  });
  it('allows identical atomic values and map-key reorder, never array concatenation', () => {
    expect(mergeFixtureValues({ a: [1], b: { x: 1 } }, { b: { x: 1, y: 2 }, a: [1] })).toEqual({ a: [1], b: { x: 1, y: 2 } });
    expect(overlayValues({ input: { files: ['a', 'b'], prompt: 'x' } }, { input: { files: ['c'] } })).toEqual({ input: { files: ['c'], prompt: 'x' } });
    for (const [a, b] of [[1, '1'], [[1, 2], [2, 1]], [{ a: 1 }, [1]]]) expect(() => mergeFixtureValues(a, b)).toThrow(/conflicting/);
  });
  it('rejects conflicts before local overrides and regardless of fixture order', () => {
    const conflict = base.replace('context: {edition:', "input: {prompt: conflict}, context: {edition:").replace(', input: {data: [1, 2]}', '');
    for (const text of [conflict, conflict.replaceAll('[defaults, evidence]', '[evidence, defaults]')]) {
      expect(() => resolveDataset(parseDatasetYaml(text), options)).toThrow(/conflicting selected fixtures/);
    }
  });
  it.each([
    [base.replaceAll('[defaults, evidence]', '[missing]'), /unknown fixture/],
    [base.replaceAll('context: edition', 'context: absent'), /missing context/],
    [base.replace("edition: '2026-09-12'", 'edition: {context: edition}'), /cycle/],
    [base.replace('date: {context: edition}', 'date: {context: edition, typo: true}'), /invalid context binding/],
    [base.replace("edition: '2026-09-12'", 'edition: 123'), /date must be text/],
    [base.replace('setup: {profile: sample, clock: {mode: emulated}}', ''), /dataset preparation profile/],
    [base.replace('setup: {clock:', 'setup: {profile: other, clock:'), /locked preparation parameter/],
  ])('fails invalid fixture setup before preparation', (text, error) => {
    expect(() => resolveDataset(parseDatasetYaml(text), options)).toThrow(error);
  });
  it('requires both recipe and invocation to unlock a changed parameter', () => {
    expect(() => resolveDataset(parseDatasetYaml(base), { registry: options.registry })).toThrow(/locked/);
    expect(() => resolveDataset(parseDatasetYaml(base), { ...options, registry: { preparations: {
      sample: { version: '1', unlockedPaths: [], validate: () => undefined },
    } } })).toThrow(/locked/);
    expect(() => resolveDataset(parseDatasetYaml(base))).toThrow(/unsupported preparation/);
  });
  it('rejects effective missing inputs and input/turns overlap after expansion', () => {
    expect(() => resolveDataset(parseDatasetYaml('schema: paideia.dataset.v1\nid: x\nrecords: [{id: x}]'))).toThrow(/exactly one/);
    const conflict = base.replace('  input: {prompt: explicit}', '  turns: [{id: t, input: {prompt: x}}]');
    expect(() => resolveDataset(parseDatasetYaml(conflict), options)).toThrow(/exactly one/);
  });
  it('rejects conflicting collector names and unsupported root recipes', () => {
    const yaml = `schema: paideia.dataset.v1
id: x
setup: {profile: sample, clock: {date: today}, artifacts: {answer: {collector: trusted}}}
records: [{id: x, input: {prompt: x}, outputs: {answer: out.json}, checks: [{id: a, eval: equals, input: output.text, value: x}]}]`;
    expect(() => resolveDataset(parseDatasetYaml(yaml), options)).toThrow(/conflicts with trusted/);
    expect(() => resolveDataset(parseDatasetYaml(yaml), {})).toThrow(/unsupported preparation/);
    expect(() => resolveDataset(parseDatasetYaml(yaml.replace('profile: sample, ', '')), options)).toThrow(/required preparation/);
  });
});

it('cannot change a locked scalar into an empty map to evade the override policy', () => {
  const changed = base.replace('profile: sample, clock:', 'profile: sample, locked: protected, clock:').replace('setup: {clock:', 'setup: {locked: {}, clock:');
  expect(() => resolveDataset(parseDatasetYaml(changed), options)).toThrow(/locked preparation parameter/);
});

it('treats outputs and context containers as maps, not binding expressions', () => {
  const source = `schema: paideia.dataset.v1
id: containers
records:
- id: task
  context: {context: literal}
  input: {prompt: Work, data: {copied: {context: context}}}
  outputs: {context: context.json}
  checks: [{id: correct, eval: equals, input: output.text, value: done}]
`;
  const result = resolveDataset(parseDatasetYaml(source));
  expect(result.records[0]!.outputs).toEqual({ context: 'context.json' });
  expect(result.records[0]!.context).toEqual({ context: 'literal' });
  expect(result.records[0]!.input!.data).toEqual({ copied: 'literal' });
});

it('rejects runtime binding tokens in preparation values before invoking the recipe', () => {
  const injected = base.replace('mode: emulated', 'mode: {binding: future.mode}');
  expect(() => resolveDataset(parseDatasetYaml(injected), options)).toThrow(/binding.*later|earlier turn/);
});

it('freezes the root preparation version in shared plan identity', () => {
  const document = parseDatasetYaml(base);
  const first = resolveDataset(document, options);
  const changed = { ...options, registry: { preparations: { sample: { ...options.registry!.preparations!.sample!, version: '2' } } } };
  expect(resolveDataset(document, changed).sharedPlanDigest).not.toBe(first.sharedPlanDigest);
});
