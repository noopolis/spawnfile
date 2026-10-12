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
    budget: { maxMetricCalls: 20, maxProposals: 10 }, search: { variants: 3, keep: 2, rounds: 2 } });
  const candidates = [[0, 0], [1, 0.8], [0.8, 0.8], [0, 1]].map(([a, b], index) => ({
    components: { A: index === 0 ? 'seed' : `candidate-${index}` }, parents: [index === 0 ? null : 0],
    validationScore: (a! + b!) / 2, discoveryEvaluations: index * 2, perCaseScores: { a: a!, b: b! },
  }));
  const rounds = [{ round: 0, parents: [], variants: [], kept: [0] }, { round: 1, parents: [0], kept: [1, 3],
    variants: [1, 2, 3].map((candidateIndex, slot) => ({ slot, parent: 0, strategy: 'rewrite', hypothesis: `hypothesis-${slot}`,
      targetedCriteria: ['quality'], behavioralChange: 0.5, lexicalChange: 0.6, status: 'accepted', rejectionReason: null,
      candidateIndex, attempts: [{ behavioralChange: 0.5, lexicalChange: 0.6, status: 'accepted', rejectionReason: null }] })) }];
  const host = new DspyHost(start, options);
  for (const candidate of candidates) for (const caseId of ['a', 'b'] as const) {
    host.completed.push({ caseId, split: 'validation', components: candidate.components,
      result: { score: candidate.perCaseScores[caseId], captureId: `capture-${host.completed.length}`, feedback: '', output: '' } });
  }
  host.evaluations = 8;
  host.proposals = 4;
  host.generations.push(...Array.from({ length: 4 }, () => ({ model: 'fake', usage: null, route: 'fake', text: 'proposal' })));
  const result = resultSchema.parse({ schema: DSPY_SCHEMA, kind: 'result', id: start.id, components: candidates[1]!.components,
    provenance: { optimizer: 'paideia.population', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
      evaluations: 8, proposals: 4, selectedCandidateIndex: 1, candidates, rounds, editScope: { A: 'whole-file' }, stopReason: 'rounds',
      captures: host.completed.map(({ caseId, split, result }) => ({ caseId, split, captureId: result.captureId })),
      generations: host.generations.map(({ model, usage }) => ({ model, usage })) } });
  return { result, start, host };
}
type Fixture = ReturnType<typeof fixture>;

it('checks Pareto retention independently, including a lower mean nondominated candidate', async () => {
  const { result, start, host } = fixture();
  await expect(verifyDspyResult(result, host, new AbortController().signal)).resolves.toBeUndefined();
  start.search!.selection = 'top-k';
  expect(() => verifyPopulationEvidence(result, start)).toThrow('selection');
  result.provenance.rounds![1]!.kept = [1, 2];
  expect(() => verifyPopulationEvidence(result, start)).not.toThrow();
  start.editScope = { A: ['Rules'] };
  result.provenance.editScope = start.editScope;
  expect(() => verifyPopulationEvidence(result, start)).not.toThrow();
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
  ['missing change', f => { f.result.provenance.rounds![1]!.variants[0]!.behavioralChange = null; }],
  ['change floor', f => { f.result.provenance.rounds![1]!.variants[0]!.behavioralChange = 0; }],
  ['rejected evaluation', f => { f.result.provenance.rounds![1]!.variants[0]!.status = 'rejected'; }],
  ['rejected reason', f => { const slot = f.result.provenance.rounds![1]!.variants[0]!; slot.status = 'rejected'; slot.candidateIndex = null; }],
  ['omitted candidate', f => { f.result.provenance.candidates.push(f.result.provenance.candidates[1]!); }],
])('rejects inconsistent population %s', (_name, mutate) => {
  const f = fixture(); mutate(f);
  expect(() => verifyPopulationEvidence(f.result, f.start)).toThrow();
});

it('accepts unevaluated rejected and empty slots with explicit reasons', () => {
  const { result, start } = fixture();
  for (const slot of result.provenance.rounds![1]!.variants.slice(1)) {
    slot.status = slot.slot === 1 ? 'rejected' : 'empty'; slot.candidateIndex = null; slot.rejectionReason = 'below floor';
  }
  result.provenance.candidates.splice(2);
  result.provenance.rounds![1]!.kept = [1, 0];
  start.proposal = { max_attempts: 1 };
  expect(() => verifyPopulationEvidence(result, start)).not.toThrow();
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
