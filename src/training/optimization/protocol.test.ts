import { describe, expect, it } from 'vitest';
import { DSPY_FRAME_BYTES, DSPY_SCHEMA, decodeMessage, encodeMessage, inferenceSchema, sameComponents, startSchema } from './protocol.js';

function start(patch: Record<string, unknown> = {}): unknown {
  return { schema: DSPY_SCHEMA, kind: 'optimize', id: 'experiment', components: { A: 'text' },
    trainCaseIds: ['train'], validationCaseIds: ['val'], budget: { maxMetricCalls: 5, maxProposals: 1 }, ...patch };
}

describe('strict DSPy protocol', () => {
  it('preserves exact strings and supplies only the GEPA seed default', () => {
    expect(startSchema.parse(start()).seed).toBe(0);
    const wire = encodeMessage({ schema: DSPY_SCHEMA, kind: 'request', id: 'call', method: 'evaluate',
      params: { caseId: 'train', split: 'train', components: { A: '\n  text 漢字\n' } } });
    expect(wire.split('\n')).toHaveLength(2);
    expect(decodeMessage(wire.trimEnd())).toMatchObject({ params: { components: { A: '\n  text 漢字\n' } } });
  });

  it.each([
    { components: {} }, { components: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, 'x'])) },
    { trainCaseIds: ['train', 'train'] }, { validationCaseIds: ['val', 'val'] },
    { validationCaseIds: ['train'] }, { testCaseIds: ['sealed'] },
    { validationCaseIds: ['v1', 'v2'], budget: { maxMetricCalls: 1, maxProposals: 1 } },
    { seed: -1 }, { budget: { maxMetricCalls: true, maxProposals: 1 } },
  ])('rejects invalid start: %j', (patch) => { expect(() => startSchema.parse(start(patch))).toThrow(); });

  it('rejects duplicate keys before JSON.parse can hide their conflicting values', () => {
    const line = '{"schema":"paideia.dspy.v1","kind":"error","id":"x","id":"y","error":{"code":"bad","message":"x"}}';
    expect(() => decodeMessage(line)).toThrow('duplicate');
    expect(() => decodeMessage(line.replace('"id":"y"', '"\\u0069d":"y"'))).toThrow('duplicate');
  });

  it('enforces finite typed JSON and exact allowed reflection controls', () => {
    expect(() => decodeMessage('null')).toThrow();
    expect(() => decodeMessage('{')).toThrow();
    expect(() => decodeMessage(JSON.stringify({ schema: DSPY_SCHEMA, kind: 'request', id: 'x', method: 'generate',
      params: { purpose: 'reflection', messages: [{ role: 'user', content: 'x' }], options: { temperature: 0.5 } } }))).toThrow();
    const line = JSON.stringify({ schema: DSPY_SCHEMA, kind: 'error', id: 'x', error: { code: 'bad', message: 'x' }, hidden: 'sealed' });
    expect(() => decodeMessage(line)).toThrow();
  });

  it('bounds both directions before sending oversized frames', () => {
    expect(() => encodeMessage({ text: 'x'.repeat(DSPY_FRAME_BYTES) })).toThrow('byte limit');
    expect(() => decodeMessage('x'.repeat(DSPY_FRAME_BYTES))).toThrow('byte limit');
  });

  it('compares full resource identities and text without normalization', () => {
    expect(sameComponents({ A: 'a' }, { A: 'a' })).toBe(true);
    expect(sameComponents({ A: 'a' }, { B: 'a' })).toBe(false);
    expect(sameComponents({ A: 'a' }, { A: 'a\n' })).toBe(false);
    expect(sameComponents({ A: 'a' }, { A: 'a', B: 'b' })).toBe(false);
  });

  it('preserves explicit model attribution and rejects invented bases', () => {
    const response = { text: 'answer', model: 'requested-alias', usage: null, route: 'subscription' };
    for (const modelBasis of ['provider-reported', 'requested-assumption']) {
      expect(inferenceSchema.parse({ ...response, modelBasis }).modelBasis).toBe(modelBasis);
    }
    expect(inferenceSchema.parse(response)).not.toHaveProperty('modelBasis');
    for (const modelBasis of ['actual', null, 1]) expect(() => inferenceSchema.parse({ ...response, modelBasis })).toThrow();
  });
});

it('mirrors strict population search defaults, constraints and complete edit scope', () => {
  const search = { variants: 3, keep: 2, rounds: 4 };
  const budget = { maxMetricCalls: 20, maxProposals: 20 };
  const parsed = startSchema.parse(start({ search, budget, editScope: { A: ['Rules'] } }));
  expect(parsed.search).toEqual({ ...search, selection: 'pareto', rewriteShare: 0.5, minChange: 0.08,
    hypothesisSimilarity: 0.6, patience: 4, boundaries: [] });
  expect(startSchema.parse(start({ search: { ...search, patience: 1, selection: 'top-k' }, budget })).search?.patience).toBe(1);
  expect(startSchema.parse(start({ search: { ...search, rounds: 1001, patience: 1001 }, budget })).search?.rounds).toBe(1001);
  for (const change of [{ keep: 4 }, { rounds: 0 }, { selection: 'random' }, { rewriteShare: 2 }, { minChange: -1 },
    { hypothesisSimilarity: 2 }, { boundaries: [''] }, { boundaries: ['x'.repeat(501)] }, { boundaries: Array(51).fill('x') },
    { patience: 0 }, { undeclared: true }]) {
    expect(() => startSchema.parse(start({ search: { ...search, ...change }, budget }))).toThrow();
  }
  expect(() => startSchema.parse(start({ search, budget: { ...budget, maxProposals: 4 } }))).toThrow('keep + variants');
  expect(() => startSchema.parse(start({ search, budget: { ...budget, maxMetricCalls: 1 } }))).toThrow('seed');
  for (const editScope of [{}, { B: 'whole-file' }, { A: [] }]) {
    expect(() => startSchema.parse(start({ search, budget, editScope }))).toThrow();
  }
});
