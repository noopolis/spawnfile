import { describe, expect, it } from 'vitest';
import { evaluateNode, evaluatePlan, mayStop, createEvaluationRegistry, result } from './index.js';
import { evaluationContext } from '../testing/index.js';
import type { EmbeddingProvider, EvaluationResult, RegisteredEvaluator } from '../contracts/evaluation.js';
import type { InferenceProvider } from '../contracts/execution.js';
import type { LiveCheck } from '../contracts/dataset.js';

const registry = createEvaluationRegistry();
describe('evaluation execution', () => {
  it('keeps evaluator mutations out of criteria, shared observations, routes and returned evidence', async () => {
    const check = { id: 'mutator', eval: 'mutator', schema: { title: 'original' } };
    const context = evaluationContext({ judges: { judge: { provider: { id: 'fixture',
      capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      generate: async () => ({ text: '', usage: null, model: 'original', route: 'fixture' }) }, model: 'original' } } });
    const returned = result('pass', 'original');
    const custom = createEvaluationRegistry({ mutator: {
      definition: { version: '1', kind: 'mechanical', incremental: true, stopProof: false,
        validate(parameters) { (parameters.schema as { title: string }).title = 'validation mutation'; } },
      evaluate: async (received, state) => {
        expect(received.schema).toEqual({ title: 'original' });
        (received.schema as { title: string }).title = 'callback mutation';
        state.snapshot.output = 'MUTATED'; state.judges.judge!.model = 'changed';
        return returned;
      },
    } });
    const report = await evaluateNode(check, context, custom);
    returned.reason = 'late mutation';
    expect(check.schema.title).toBe('original'); expect(context.snapshot.output).toBe('4');
    expect(context.judges.judge!.model).toBe('original'); expect(report.reason).toBe('original');
  });
  it('isolates provider metadata and route dictionaries while preserving native method receivers', async () => {
    const provider: InferenceProvider = { id: 'judge-original',
      capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      async generate(request) {
        expect(this).toBe(provider);
        return { text: this.id, usage: null, model: request.model, route: this.capabilities.billing };
      },
    };
    const embedding: EmbeddingProvider = { id: 'embedding-original', version: 'v1', async embed() {
      expect(this).toBe(embedding); expect(this.id).toBe('embedding-original');
      return { vectors: [[1]], usage: null };
    } };
    const context = evaluationContext({ judges: { judge: { provider, model: 'original-model' } }, embeddings: { local: embedding },
      results: { prior: result('pass', 'original-result') },
      scores: { prior: { finality: 'final', lower: 1, upper: 1, assessedWeight: 1, missingWeight: 0 } } });
    const custom = createEvaluationRegistry({ mutator: {
      definition: { version: '1', kind: 'mechanical', incremental: true, stopProof: false, validate() {} },
      evaluate: async (_check, state) => {
        state.results.prior!.reason = 'changed'; state.scores.prior!.lower = 0;
        state.judges.judge!.model = 'changed'; state.judges.judge!.provider.id = 'changed';
        (state.judges.judge!.provider.capabilities as { billing: string }).billing = 'changed';
        state.embeddings.local!.id = 'changed'; state.embeddings.local!.version = 'changed';
        expect(await state.judges.judge!.provider.generate({ prompt: 'fixture', model: 'explicit' }))
          .toMatchObject({ text: 'judge-original', route: 'subscription' });
        expect(await state.embeddings.local!.embed(['fixture'], 'explicit')).toMatchObject({ vectors: [[1]] });
        delete (state.judges as Record<string, unknown>).judge;
        delete (state.embeddings as Record<string, unknown>).local;
        return result('pass', 'mutations remained local');
      },
    } });
    expect((await evaluateNode({ eval: 'mutator' }, context, custom)).status).toBe('pass');
    // A second callback must still receive the original routes and state.
    expect((await evaluateNode({ eval: 'mutator' }, context, custom)).status).toBe('pass');
    expect(context.judges.judge).toEqual({ provider, model: 'original-model' });
    expect(provider.id).toBe('judge-original'); expect(provider.capabilities.billing).toBe('subscription');
    expect(context.embeddings.local).toBe(embedding); expect(embedding).toMatchObject({ id: 'embedding-original', version: 'v1' });
    expect(context.results.prior!.reason).toBe('original-result'); expect(context.scores.prior!.lower).toBe(1);
  });
  it('returns explicit errors for unsupported nodes, malformed provider results and cancelled work', async () => {
    for (const check of [{}, { eval: 'unknown' }, { eval: 'equals', input: 'output.text' }]) {
      expect((await evaluateNode(check, evaluationContext(), registry)).status).toBe('error');
    }
    const controller = new AbortController();controller.abort();
    expect((await evaluateNode({ eval: 'equals' }, evaluationContext({ signal: controller.signal }), registry)).reason).toContain('cancelled');
    const open = { ...evaluationContext(), snapshot: { ...evaluationContext().snapshot, closed: false } };
    expect((await evaluateNode({ eval: 'unknown' }, open, registry)).finality).toBe('provisional');
    expect((await evaluateNode({ eval: 'equals' }, { ...open, signal: controller.signal }, registry)).finality).toBe('provisional');
    const definition = { version: 'test', kind: 'mechanical' as const, incremental: true, stopProof: true, validate() {} };
    const invalid = [null, { ...result('pass', 'ok'), score: 2 }, { ...result('pass', 'ok'), evidence: null },
      { ...result('pass', 'ok'), finality: 'unknown' }, { ...result('pass', 'ok'), status: 'maybe' },
      { ...result('pass', 'ok'), reason: 4 }];
    for (const value of invalid) {
      const custom = createEvaluationRegistry({ invalid: { definition, evaluate: async () => value as EvaluationResult } });
      expect((await evaluateNode({ eval: 'invalid' }, evaluationContext(), custom)).status).toBe('error');
    }
    const throws = createEvaluationRegistry({ throws: { definition, evaluate: async () => { throw 'native failure'; } } });
    expect((await evaluateNode({ eval: 'throws' }, evaluationContext(), throws)).reason).toBe('native failure');
    expect(() => createEvaluationRegistry({ equals: {} as RegisteredEvaluator })).toThrow('replace');
  });
  it('evaluates logical references without promoting missing observations', async () => {
    const context = evaluationContext({ results: { existing: result('pass', 'observed') } });
    expect((await evaluateNode({ passed: 'existing' }, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ passed: 'missing' }, context, registry)).status).toBe('unknown');
    expect((await evaluateNode({ score: 'existing', at_least: 0.5 }, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ score: 'missing', at_least: 0.5 }, context, registry)).status).toBe('unknown');
    const nested = { any: [{ not: { eval: 'equals', input: 'output.text', value: '5' } }, { passed: 'missing' }] };
    expect((await evaluateNode(nested, context, registry)).status).toBe('pass');
  });
  it('keeps progressive stage dependencies separate from action ordering and grade weights', async () => {
    const stages = [
      { id: 'mechanics', checks: [{ id: 'format', eval: 'equals', input: 'output.text', value: 'wrong' }] },
      { id: 'writing', when: { passed: 'mechanics' },
        checks: [{ id: 'prose', eval: 'equals', input: 'output.text', value: '4' }],
        score: { linear: { prose: 1 } }, gate: { score: 'writing', at_least: 0.8 } },
    ];
    const failed = await evaluatePlan(stages, evaluationContext(), registry);
    expect(failed.status).toBe('fail');expect(failed.checks.prose!.status).toBe('skipped');
    expect(failed.scores.writing!.missingWeight).toBe(1);
    stages[0]!.checks[0]!.value = '4';
    const passed = await evaluatePlan(stages, evaluationContext(), registry);
    expect(passed.status).toBe('pass');expect(passed.scores.writing!.lower).toBe(1);
  });
  it('does not grant semantic or unresolved nested expressions live stop authority', () => {
    const stop = { id: 'live', on: 'event' as const, on_fail: 'stop' as const };
    const called = { eval: 'tool-called', tool: 'forbidden' };
    expect(mayStop({ ...stop, not: called }, registry)).toBe(true);
    expect(mayStop({ ...stop, all: [called, { any: [called] }] }, registry)).toBe(true);
    expect(mayStop({ ...stop, eval: 'equals', on_fail: 'continue' }, registry)).toBe(false);
    expect(() => mayStop({ ...stop, eval: 'tool-called', tool: 'forbidden',
      all: [{ eval: 'llm-rubric' }] }, registry)).toThrow();
    for (const node of [{ eval: 'llm-rubric' }, { eval: 'embedding-similarity' }, { eval: 'absent' },
      { not: { eval: 'llm-rubric' } }, { all: [] }, { passed: 'semantic' }, { use: 'unresolved' }]) {
      expect(() => mayStop({ ...stop, ...node } as LiveCheck, registry)).toThrow();
    }
  });
  it('rejects ambiguous operators in execution and retains provisional numeric gates', async () => {
    const ambiguous = { eval: 'equals', input: 'output.text', value: '4', all: [{ passed: 'missing' }] };
    expect((await evaluateNode(ambiguous, evaluationContext(), registry)).status).toBe('error');
    const report = await evaluatePlan([{ id: 'quality',
      checks: [{ id: 'grade', eval: 'equals', input: 'output.text', value: '4' }],
      score: { linear: { grade: 1 } }, gate: { score: 'quality', at_least: 0.8 } }],
    { ...evaluationContext(), snapshot: { ...evaluationContext().snapshot, closed: false } }, registry);
    expect(report.stages[0]!.gate.finality).toBe('provisional');
  });
});
