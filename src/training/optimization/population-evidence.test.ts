import { expect, it } from 'vitest';
import { DspyHost } from './host.js';
import { verifyDspyResult } from './evidence.js';
import { verifyPopulationEvidence } from './population-evidence.js';
import { DSPY_SCHEMA, resultSchema, startSchema } from './protocol.js';
import { simulatedOptions } from './testSupport.js';

function fixture() {
  const { options } = simulatedOptions();
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: 'population',
    components: { A: 'seed' }, trainCaseIds: ['train'], validationCaseIds: ['a', 'b'],
    budget: { maxMetricCalls: 20, maxProposals: 10 }, search: { variants: 3, keep: 2, rounds: 1 } });
  const candidates = [[0, 0], [1, 0.8], [0.8, 0.8], [0, 1]].map(([a, b], index) => ({
    components: { A: index === 0 ? 'seed' : `candidate-${index}` }, parents: [index === 0 ? null : 0],
    validationScore: (a! + b!) / 2, discoveryEvaluations: index === 0 ? 0 : index * 2 + 1, perCaseScores: { a: a!, b: b! },
  }));
  const rounds = [{ round: 0, parents: [], variants: [], kept: [0] }, { round: 1, parents: [0], kept: [1, 3],
    variants: [1, 2, 3].map((candidateIndex, slot) => ({ slot, parent: 0, strategy: slot < 2 ? 'rewrite' : 'refine', hypothesis: `hypothesis-${slot}`,
      targetedCriteria: ['quality'], behavioralChange: 0.5, lexicalChange: 0.6, status: 'accepted', rejectionReason: null,
      candidateIndex, attempts: [{ behavioralChange: 0.5, lexicalChange: 0.6, status: 'accepted', rejectionReason: null }] })) }];
  const host = new DspyHost(start, options);
  for (const candidate of candidates) for (const caseId of ['a', 'b'] as const) {
    host.completed.push({ caseId, split: 'validation', components: candidate.components,
      result: { score: candidate.perCaseScores[caseId], captureId: `capture-${host.completed.length}`, feedback: '', output: '' } });
  }
  host.completed.splice(2, 0, { caseId: 'train', split: 'train', components: start.components,
    result: { score: 0, captureId: 'seed-train', feedback: '', output: '' } });
  for (const candidate of candidates.slice(1)) host.completed.push({ caseId: 'train', split: 'train', components: candidate.components,
    result: { score: 0, captureId: `train-${candidate.components.A}`, feedback: '', output: '' } });
  host.evaluations = 12;
  host.proposals = 4;
  host.generations.push(...[
    { hypotheses: rounds[1]!.variants.map(slot => ({ strategy: slot.strategy, targetedCriteria: slot.targetedCriteria })) },
    ...rounds[1]!.variants.map(slot => ({ components: candidates[slot.candidateIndex]!.components,
      hypothesis: slot.hypothesis, expectedImpact: [{ criterion: 'quality', effect: 'improves' }] })),
  ].map(body => ({ model: 'fake', usage: null, route: 'fake', text: JSON.stringify(body) })));
  const result = resultSchema.parse({ schema: DSPY_SCHEMA, kind: 'result', id: start.id, components: candidates[1]!.components,
    provenance: { optimizer: 'paideia.population', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
      evaluations: 12, changeEvidence: 'bridge-reported-v2', proposals: 4, selectedCandidateIndex: 1, candidates, rounds, editScope: { A: 'whole-file' }, stopReason: 'rounds',
      captures: host.completed.map(({ caseId, split, result }) => ({ caseId, split, captureId: result.captureId })),
      generations: host.generations.map(({ model, usage, text }) => ({ model, usage, text })) } });
  return { result, start, host };
}
type Fixture = ReturnType<typeof fixture>;

it.each(['missing', 'duplicate', 'wrong case', 'wrong components'])('rejects incomplete candidate training: %s', mutation => {
  const f = fixture();
  const index = f.host.completed.findIndex(row => row.split === 'train' && row.components.A === 'candidate-1');
  const row = f.host.completed[index]!;
  if (mutation === 'missing') f.host.completed.splice(index, 1);
  else if (mutation === 'duplicate') f.host.completed.push(row);
  else if (mutation === 'wrong case') row.caseId = 'sealed';
  else row.components = { A: 'seed' };
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).toThrow('complete train');
});

it('checks Pareto retention independently, including a lower mean nondominated candidate', async () => {
  const { result, start, host } = fixture();
  await expect(verifyDspyResult(result, host, new AbortController().signal)).resolves.toBeUndefined();
  start.search!.selection = 'top-k';
  expect(() => verifyPopulationEvidence(result, start, host.completed)).toThrow('selection');
  result.provenance.rounds![1]!.kept = [1, 2];
  expect(() => verifyPopulationEvidence(result, start, host.completed)).not.toThrow();
  start.editScope = { A: ['Rules'] };
  result.provenance.editScope = start.editScope;
  expect(() => verifyPopulationEvidence(result, start, host.completed)).not.toThrow();
});

it.each<[string, (f: Fixture) => void]>([
  ['missing search', f => { delete f.start.search; }],
  ['missing rounds', f => { delete f.result.provenance.rounds; }],
  ['empty rounds', f => { f.result.provenance.rounds = []; }],
  ['excess rounds', f => { f.result.provenance.rounds!.push(...f.result.provenance.rounds!); }],
  ['scope', f => { f.result.provenance.editScope = { A: ['Other'] }; }],
  ['round number', f => { f.result.provenance.rounds![1]!.round = 3; }],
  ['round parents', f => { f.result.provenance.rounds![1]!.parents = [1]; }],
  ['baseline slots', f => { f.result.provenance.rounds![0]!.variants.push(f.result.provenance.rounds![1]!.variants[0]!); }],
  ['slot count', f => { f.result.provenance.rounds![1]!.variants.pop(); }],
  ['slot ordinal', f => { f.result.provenance.rounds![1]!.variants[0]!.slot = 1; }],
  ['slot parent', f => { f.result.provenance.rounds![1]!.variants[0]!.parent = 2; }],
  ['attempt bound', f => { const slot = f.result.provenance.rounds![1]!.variants[0]!; slot.attempts.push(...slot.attempts, ...slot.attempts); }],
  ['null candidate', f => { f.result.provenance.rounds![1]!.variants[0]!.candidateIndex = null; }],
  ['absent candidate', f => { f.result.provenance.rounds![1]!.variants[0]!.candidateIndex = 9; }],
  ['reused candidate', f => { f.result.provenance.rounds![1]!.variants[1]!.candidateIndex = 1; }],
  ['candidate parent', f => { f.result.provenance.candidates[1]!.parents = [2]; }],
  ['accepted reason', f => { f.result.provenance.rounds![1]!.variants[0]!.rejectionReason = 'rejected'; }],
  ['rejected evaluation', f => { f.result.provenance.rounds![1]!.variants[0]!.status = 'rejected'; }],
  ['rejected reason', f => { const slot = f.result.provenance.rounds![1]!.variants[0]!; slot.status = 'rejected'; slot.candidateIndex = null; }],
  ['omitted candidate', f => { f.result.provenance.candidates.push(f.result.provenance.candidates[1]!); }],
])('rejects inconsistent population %s', (_name, mutate) => {
  const f = fixture(); mutate(f);
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).toThrow();
});

it('rejects population mode forgery and per-case scores even when the mean still matches', async () => {
  const { result, host } = fixture();
  const signal = new AbortController().signal;
  result.provenance.optimizer = 'dspy.GEPA';
  await expect(verifyDspyResult(result, host, signal)).rejects.toThrow('mode');
  result.provenance.optimizer = 'paideia.population';
  result.provenance.candidates[1]!.perCaseScores = { a: 0.8, b: 1 };
  await expect(verifyDspyResult(result, host, signal)).rejects.toThrow('per-case');
});

function syncHost(f: Fixture) {
  f.result.provenance.evaluations = f.host.evaluations = f.host.completed.length;
  f.result.provenance.proposals = f.host.proposals = f.host.generations.length;
  f.result.provenance.captures = f.host.completed.map(({ caseId, split, result }) => ({ caseId, split, captureId: result.captureId }));
  f.result.provenance.generations = f.host.generations.map(({ model, usage, text }) => ({ model, usage, text }));
}

function concurrentSeedFixture() {
  const f = fixture();
  f.start.concurrency = 2;
  f.start.trainCaseIds.push('other-train');
  const original = f.host.completed[2]!;
  f.host.completed.splice(2, 0, { ...original, caseId: 'other-train', result: { ...original.result, captureId: 'other-seed-train' } });
  for (const candidate of f.result.provenance.candidates.slice(1)) candidate.discoveryEvaluations++;
  for (const candidate of f.result.provenance.candidates.slice(1)) f.host.completed.push({ ...original,
    caseId: 'other-train', components: candidate.components, result: { ...original.result, captureId: `other-${candidate.components.A}` } });
  syncHost(f);
  return f;
}

it('accepts complete seed training when concurrent callbacks finish in reverse case order', async () => {
  const f = concurrentSeedFixture();
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).resolves.toBeUndefined();
});

it.each<[string, (f: Fixture) => void]>([
  ['duplicate case', f => { f.host.completed[2]!.caseId = 'train'; }],
  ['unknown case', f => { f.host.completed[2]!.caseId = 'unknown'; }],
  ['wrong split', f => { f.host.completed[2]!.split = 'validation'; }],
  ['wrong candidate', f => { f.host.completed[2]!.components = { A: 'other' }; }],
  ['missing case', f => { f.host.completed.splice(2, 1); }],
])('rejects incomplete concurrent seed training: %s', (_name, mutate) => {
  const f = concurrentSeedFixture();
  mutate(f);
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).toThrow('seed train');
});

function changeResponse(f: Fixture, index: number, update: (body: Record<string, unknown>) => void) {
  const generation = f.host.generations[index]!;
  const body = JSON.parse(generation.text) as Record<string, unknown>;
  update(body);
  generation.text = JSON.stringify(body);
}

it.each<[string, (f: Fixture) => void, string]>([
  ['early rounds stop', f => { f.start.search!.rounds = 2; }, 'stop reason'],
  ['budget with ample room', f => { f.start.search!.rounds = 2; f.result.provenance.stopReason = 'budget'; }, 'stop reason'],
  ['patience before stagnation', f => { f.start.search!.rounds = 2; f.result.provenance.stopReason = 'patience'; }, 'stop reason'],
  ['unknown stop', f => { f.result.provenance.stopReason = 'invented'; }, 'stop reason'],
  ['wrong rewrite allocation', f => {
    f.result.provenance.rounds![1]!.variants[2]!.strategy = 'rewrite';
    changeResponse(f, 0, body => { (body.hypotheses as Array<{ strategy: string }>)[2]!.strategy = 'rewrite'; });
  }, 'slot'],
  ['accepted without attempts', f => {
    f.result.provenance.rounds![1]!.variants[2]!.attempts = [];
    f.host.generations.pop();
  }, 'attempts'],
  ['accepted empty hypothesis', f => {
    f.result.provenance.rounds![1]!.variants[0]!.hypothesis = '';
    changeResponse(f, 1, body => { body.hypothesis = ''; });
  }, 'hypothesis'],
  ['accepted with rejected final attempt', f => {
    f.result.provenance.rounds![1]!.variants[0]!.attempts[0]!.status = 'rejected';
  }, 'attempts'],
  ['accepted missing candidate index', f => { f.result.provenance.rounds![1]!.variants[0]!.candidateIndex = null; }, 'lineage'],
  ['unrecorded candidate components', f => {
    f.result.provenance.candidates[1]!.components = { A: '**seed**' };
    f.result.components = { A: '**seed**' };
    for (const row of f.host.completed) if (row.components.A === 'candidate-1') row.components = { A: '**seed**' };
    f.result.provenance.rounds![1]!.variants[0]!.behavioralChange = 1;
  }, 'recorded realization'],
  ['missing round-zero train', f => { f.host.completed.splice(2, 1); }, 'seed train'],
  ['wrong seed train components', f => { f.host.completed[2]!.components = { A: 'other' }; }, 'seed train'],
  ['missing heuristic disclosure', f => { delete f.result.provenance.changeEvidence; }, 'bridge-reported'],
])('rejects forged host-consistent population evidence: %s', async (_name, mutate, error) => {
  const f = fixture(); mutate(f); syncHost(f);
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).rejects.toThrow(error);
});

it('binds response text to host generations before population verification', async () => {
  const f = fixture();
  f.result.provenance.generations[1]!.text = '{}';
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).rejects.toThrow('inference provenance');
});

it('does not certify bridge-reported heuristic numbers', async () => {
  const f = fixture();
  const slot = f.result.provenance.rounds![1]!.variants[0]!;
  slot.behavioralChange = 0; slot.lexicalChange = 1;
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).resolves.toBeUndefined();
  expect(f.result.provenance.changeEvidence).toBe('bridge-reported-v2');
});

it('rejects seed-only rounds completion even with otherwise authentic seed captures', async () => {
  const f = fixture();
  f.start.search!.rounds = 2;
  f.result.provenance.rounds!.splice(1);
  f.result.provenance.candidates.splice(1);
  f.result.provenance.selectedCandidateIndex = 0; f.result.components = f.start.components;
  f.host.completed.splice(3); f.host.generations.splice(0); syncHost(f);
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).rejects.toThrow('stop reason');
  f.result.provenance.stopReason = 'budget';
  f.start.budget.maxMetricCalls = 3;
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).resolves.toBeUndefined();
});

it('accepts genuine patience and exhausted-budget stops', () => {
  const f = fixture();
  f.start.search!.rounds = 2;
  f.result.provenance.stopReason = 'budget';
  f.start.budget.maxProposals = f.host.proposals;
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).not.toThrow();
  f.result.provenance.stopReason = 'patience';
  f.start.search!.patience = 1;
  f.result.provenance.candidates[0]!.validationScore = 0.9;
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).not.toThrow();
});

it('accepts rejected attempts and a planned empty slot only at a real budget stop', async () => {
  const f = fixture();
  const [accepted, rejected, empty] = f.result.provenance.rounds![1]!.variants;
  expect(accepted!.status).toBe('accepted');
  rejected!.status = 'rejected'; rejected!.candidateIndex = null; rejected!.rejectionReason = 'below-min-change';
  rejected!.attempts[0]!.status = 'rejected'; rejected!.attempts[0]!.rejectionReason = 'below-min-change';
  empty!.status = 'empty'; empty!.candidateIndex = null; empty!.rejectionReason = 'budget'; empty!.attempts = [];
  f.result.provenance.candidates.splice(2); f.result.provenance.rounds![1]!.kept = [1, 0];
  f.host.generations.pop(); f.host.completed.splice(0, f.host.completed.length, ...f.host.completed.filter(row => row.components.A === 'seed' || row.components.A === 'candidate-1')); syncHost(f);
  f.result.provenance.stopReason = 'budget'; f.start.budget.maxMetricCalls = f.host.evaluations;
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).resolves.toBeUndefined();
  f.start.budget.maxMetricCalls = 20;
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).rejects.toThrow('stop reason');
  empty!.attempts.push({ status: 'rejected', rejectionReason: 'duplicate', behavioralChange: 0, lexicalChange: 0 });
  f.host.generations.push(f.host.generations.at(-1)!); syncHost(f);
  await expect(verifyDspyResult(f.result, f.host, new AbortController().signal)).rejects.toThrow('attempts');
});

it.each<[string, (f: Fixture) => void, string]>([
  ['no response text', f => { delete f.result.provenance.generations[0]!.text; }, 'recorded generation'],
  ['non-object response', f => { f.result.provenance.generations[0]!.text = 'null'; }, 'not an object'],
  ['bad plan count', f => { f.result.provenance.generations[0]!.text = '{"hypotheses":[]}'; }, 'planning response'],
  ['extra response', f => { f.result.provenance.generations.push(f.result.provenance.generations[0]!); }, 'omit recorded generations'],
  ['prior accepted attempt', f => {
    const slot = f.result.provenance.rounds![1]!.variants[0]!;
    slot.attempts.unshift(slot.attempts[0]!);
    f.result.provenance.generations.splice(1, 0, f.result.provenance.generations[1]!);
  }, 'attempts'],
])('rejects malformed population history: %s', (_name, mutate, error) => {
  const f = fixture(); mutate(f);
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).toThrow(error);
});

it('accepts the bridge whole JSON fence and a rejected-then-accepted repair', () => {
  const f = fixture();
  const slot = f.result.provenance.rounds![1]!.variants[0]!;
  slot.attempts.unshift({ status: 'rejected', rejectionReason: 'below-min-change', behavioralChange: 0, lexicalChange: 0 });
  f.result.provenance.generations.splice(1, 0, { model: 'fake', usage: null, text: '{}' });
  for (const generation of f.result.provenance.generations) generation.text = `\`\`\`json\n${generation.text}\n\`\`\``;
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).not.toThrow();
});

it('rejects continuation after an observed patience stop', () => {
  const f = fixture();
  f.start.search!.rounds = 3; f.start.search!.patience = 1;
  f.result.provenance.candidates[0]!.validationScore = 0.9;
  f.result.provenance.rounds!.push({ round: 2, parents: [1, 3], variants: [], kept: [1, 3] });
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).toThrow('continued after');
});

it.each([
  { quality: 'improves' }, [], [null], [{ effect: 'improves' }],
  [{ criterion: 'invented', effect: 'improves' }],
  [{ criterion: 'quality', effect: 'first' }, { criterion: 'quality', effect: 'second' }],
])('rejects recorded impact criteria inconsistent with the accepted slot: %j', expectedImpact => {
  const f = fixture();
  const generation = f.result.provenance.generations[1]!;
  generation.text = JSON.stringify({ ...JSON.parse(generation.text!), expectedImpact });
  expect(() => verifyPopulationEvidence(f.result, f.start, f.host.completed)).toThrow('recorded realization');
});
