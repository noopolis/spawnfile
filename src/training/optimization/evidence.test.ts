import { describe, expect, it } from 'vitest';
import { DspyHost } from './host.js';
import { verifyDspyResult } from './evidence.js';
import { DSPY_SCHEMA, resultSchema, startSchema } from './protocol.js';
import { simulatedOptions } from './testSupport.js';

async function fixture() {
  const { options } = simulatedOptions();
  options.validationCaseIds = ['validation-a', 'validation-b'];
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: options.id, components: options.components,
    trainCaseIds: options.trainCaseIds, validationCaseIds: options.validationCaseIds, budget: options.budget, seed: options.seed });
  const host = new DspyHost(start, options);
  const signal = new AbortController().signal;
  let sequence = 0;
  const evaluate = async (components: Record<string, string>, split: 'train' | 'validation') => {
    for (const caseId of split === 'train' ? start.trainCaseIds : start.validationCaseIds) {
      await host.handle({ schema: DSPY_SCHEMA, kind: 'request', id: `call-${sequence++}`, method: 'evaluate',
        params: { caseId, split, components } }, signal);
    }
  };
  await evaluate(start.components, 'validation');
  await evaluate(start.components, 'train');
  const proposed = await host.handle({ schema: DSPY_SCHEMA, kind: 'request', id: `call-${sequence++}`, method: 'generate',
    params: { purpose: 'reflection', options: {}, messages: [{ role: 'system', content: 'reflect' },
      { role: 'user', content: JSON.stringify({ currentComponents: start.components, updateOnly: Object.keys(start.components) }) }] } }, signal) as { text: string };
  const improved = JSON.parse(proposed.text) as Record<string, string>;
  await evaluate(improved, 'train');
  await evaluate(improved, 'validation');
  const result = resultSchema.parse({ schema: DSPY_SCHEMA, kind: 'result', id: start.id, components: improved, provenance: {
    optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: start.seed,
    evaluations: host.evaluations, proposals: host.proposals, selectedCandidateIndex: 1,
    candidates: [{ components: start.components, parents: [null], validationScore: 0, discoveryEvaluations: 0 },
      { components: improved, parents: [0], validationScore: 0.5, discoveryEvaluations: 4 }],
    captures: host.completed.map(({ caseId, split, result }) => ({ caseId, split, captureId: result.captureId })),
    generations: host.generations.map(({ model, usage }) => ({ model, usage })),
  } });
  return { result, host, signal };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe('terminal optimization evidence', () => {
  it('verifies complete multi-case validation from host evidence', async () => {
    const { result, host, signal } = await fixture();
    await expect(verifyDspyResult(result, host, signal)).resolves.toBeUndefined();
  });

  it('accepts checkpoint object-key reordering while preserving every nested usage value', async () => {
    const f = await fixture();
    const usage = { cachedInputTokens: 128, cacheWriteInputTokens: 0, inputTokens: 8030,
      outputTokens: 843, reasoningTokens: null, source: 'grok.result.usage.lower-bound' };
    f.host.generations[0]!.usage = usage;
    f.host.generations[0]!.modelBasis = 'provider-reported';
    f.result = resultSchema.parse({ ...f.result, provenance: { ...f.result.provenance,
      generations: [{ model: f.host.generations[0]!.model, usage, modelBasis: 'provider-reported' }] } });
    expect(Object.keys(f.host.generations[0]!.usage!)).not.toEqual(Object.keys(f.result.provenance.generations[0]!.usage!));
    await expect(verifyDspyResult(f.result, f.host, f.signal)).resolves.toBeUndefined();
    for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'cacheWriteInputTokens', 'reasoningTokens'] as const) {
      const changed = structuredClone(f.result); changed.provenance.generations[0]!.usage![field] = 1;
      await expect(verifyDspyResult(changed, f.host, f.signal)).rejects.toThrow('provenance');
    }
    const reordered = structuredClone(f.result); reordered.provenance.captures.reverse();
    await expect(verifyDspyResult(reordered, f.host, f.signal)).rejects.toThrow('provenance');
  });

  it.each<[string, (value: Fixture) => void]>([
    ['identity', ({ result }) => { result.id = 'another'; }],
    ['seed', ({ result }) => { result.provenance.seed += 1; }],
    ['trial count', ({ result }) => { result.provenance.evaluations += 1; }],
    ['proposal count', ({ result }) => { result.provenance.proposals += 1; }],
    ['candidate count', ({ result }) => { result.provenance.candidates.push(result.provenance.candidates[1]!); }],
    ['pending host work', ({ host }) => { host.pending = 1; }],
    ['capture provenance', ({ result }) => { result.provenance.captures[0]!.captureId = 'forged'; }],
    ['generation identity', ({ result }) => { result.provenance.generations[0]!.model = 'invented'; }],
    ['generation attribution', ({ result }) => { result.provenance.generations[0]!.modelBasis = 'requested-assumption'; }],
    ['missing validation', ({ result }) => { result.provenance.candidates.pop(); }],
    ['baseline text', ({ result }) => { result.provenance.candidates[0]!.components['AGENTS.md'] = 'altered'; }],
    ['baseline parent count', ({ result }) => { result.provenance.candidates[0]!.parents = []; }],
    ['baseline parent identity', ({ result }) => { result.provenance.candidates[0]!.parents = [0]; }],
    ['self-parent', ({ result }) => { result.provenance.candidates[1]!.parents = [1]; }],
    ['absent parent', ({ result }) => { result.provenance.candidates[1]!.parents = [null]; }],
    ['multiple parents', ({ result }) => { result.provenance.candidates[1]!.parents = [0, 0]; }],
    ['future discovery', ({ result }) => { result.provenance.candidates[1]!.discoveryEvaluations = 99; }],
    ['baseline discovery', ({ result }) => { result.provenance.candidates[0]!.discoveryEvaluations = 1; }],
    ['reversed discovery', ({ result }) => { result.provenance.candidates[1]!.discoveryEvaluations = 0; }],
    ['wrong candidate input', ({ host }) => { host.completed[0]!.components = { A: 'other' }; }],
    ['score', ({ result }) => { result.provenance.candidates[1]!.validationScore = 0.9; }],
    ['selection', ({ result }) => { result.provenance.selectedCandidateIndex = 0; }],
    ['selected bytes', ({ result }) => { result.components = result.provenance.candidates[0]!.components; }],
  ])('rejects fabricated %s', async (_name, mutate) => {
    const data = await fixture();
    mutate(data);
    await expect(verifyDspyResult(data.result, data.host, data.signal)).rejects.toThrow();
  });

  it.each(['duplicate', 'undeclared'])('rejects %s validation case coverage', async (kind) => {
    const { result, host, signal } = await fixture();
    host.completed[0]!.caseId = kind === 'duplicate' ? 'validation-b' : 'undeclared';
    result.provenance.captures[0]!.caseId = host.completed[0]!.caseId;
    await expect(verifyDspyResult(result, host, signal)).rejects.toThrow('declared native validation');
  });

  it('keeps the earlier candidate on a validation tie', async () => {
    const { result, host, signal } = await fixture();
    result.provenance.candidates[1]!.validationScore = 0;
    for (const entry of host.completed.slice(-2)) entry.result.score = 0;
    result.provenance.selectedCandidateIndex = 0;
    result.components = result.provenance.candidates[0]!.components;
    await expect(verifyDspyResult(result, host, signal)).resolves.toBeUndefined();
  });
});
