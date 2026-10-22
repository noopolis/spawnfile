import { expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { parseDatasetYaml, resolveDataset, type GraderBinding } from '../../cases/index.js';
import { parseAtomicGrader, type AtomicRuntime } from '../../graders/atomic/index.js';
import { parseCheckTemplates, parseDecomposition } from '../../graders/decomposition/index.js';
import { createEvaluationRegistry, evaluatePlan } from '../../evaluation/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';
import { trialScore } from './scoring.js';

function fixture(missing: 'fail' | 'unknown', outcome: 'error' | 'pass' | 'fail' = 'error', composition?: 'all' | 'any') {
  const judgeCheck = { eval: 'llm-rubric', input: 'artifact:article', judge: 'editor',
    rubric: { prompt: 'Grade the accepted artifact.' }, minimum: 0.8 };
  const acceptance = composition ? { [composition]: [judgeCheck,
    { eval: 'equals', input: 'artifact:article#/body/0', value: composition === 'all' ? 'different' : 'Alice joined.' }] } : judgeCheck;
  const grader = parseAtomicGrader({ schema: 'paideia.atomic-grader.v1', id: 'quality', templates: 'templates.yaml',
    extractor: { provider: 'codex', model: 'test' }, decision: { backend: 'typesafe', model: 'jev-1.0.0', max_spend_usd: 1 }, missing,
    gates: [{ id: 'accepted', check: acceptance }],
    aggregation: { method: 'gates-times-coverage-times-quality', critical_pass_at: 0.8, pass_at: 0.5, obligation_kinds: ['obligation'],
      dimensions: { coverage: { weight: 1, budget: 2 } }, penalties: { critical: 1, major: 0.5, minor: 0.1 } } });
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', context: { assignment: { role: 'assignment' } },
    templates: [{ id: 'covered', applies_to: 'obligation', type: 'noul', instructions: 'Covered?', criteria: { true: 'Good', false: 'Bad' },
      expected: [true], state: ['unit', 'output.body'], dimension: 'coverage', severity: 'major' }] });
  const resources: Record<string, string> = { 'grader.yaml': stringify(grader), 'templates.yaml': stringify(templates) };
  const dataset = resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id: 'gated',
    checks: [{ id: 'quality', eval: 'grader', grader: 'grader.yaml', input: 'artifact:article', context: { assignment: 'artifact:assignment' } }],
    records: [{ id: 'one', input: { prompt: 'Write' }, outputs: { article: 'out.json' } }] }), { sourceName: '/dataset.yaml' }),
  { readCriterionFile: name => resources[name]!, registry: { judges: { editor: { version: 'offline-v1' } } } });
  const check = dataset.sharedStages[0]!.checks[0]!;
  const binding = check.grader_binding as GraderBinding;
  const receipt = { provider: 'codex', model: 'test', prompt_digest: 'c'.repeat(64), at: '2026-10-14T00:00:00Z' };
  const runtime: AtomicRuntime = { kind: 'atomic', grader, templates,
    definitionDigest: binding.definitionDigest, templatesDigest: binding.templatesDigest!, resource: {},
    backend: { identity: vi.fn(async () => ({ backend: 'typesafe', model: grader.decision.model })),
      score: vi.fn<AtomicRuntime['backend']['score']>(async requests => requests.map(request =>
        ({ key: request.key, status: 'ok', probabilities: { true: 1, false: 0 } }))) },
    extract: vi.fn(async () => ({ decomposition: parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'trial', sha256: 'c'.repeat(64) },
      units: [{ id: 'one', kind: 'obligation', text: 'Cover Alice.' }], extractors: [receipt], audit: { extractor: receipt, missed: [], at: receipt.at } }),
    receipts: [], judgeCalls: [] })) };
  const provider: InferenceProvider = { id: 'offline-subscription',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: vi.fn(async () => {
      if (outcome === 'error') throw new Error('Provider unavailable');
      return { text: JSON.stringify({ score: outcome === 'pass' ? 1 : 0, verdict: outcome, reasons: ['Gate judgment'],
        citations: [{ source: 'input', quote: 'Alice joined.' }] }), model: 'test', route: 'offline-subscription', usage: null };
    }) };
  const context = evaluationContext({ graders: { [check.grader as string]: runtime }, judges: { editor: { provider, model: 'test' } },
    snapshot: snapshot({ artifacts: { article: artifact({ body: ['Alice joined.'] }), assignment: { ...artifact('Cover Alice.'), name: 'assignment' } } }) });
  async function measure(mode: 'plain' | 'sibling' | 'passing-gate', nested: boolean) {
    const quality = nested ? { id: 'quality', all: [check] } : check;
    const evaluation = await evaluatePlan([{ id: 'terminal', checks: [quality,
      ...(mode === 'sibling' ? [{ id: 'other', eval: 'equals', input: 'output.text', value: 'different' }] : [])],
    ...(mode === 'passing-gate' ? { gate: { eval: 'equals', input: 'output.text', value: '4' } } : {}) }], context, createEvaluationRegistry());
    const report: Parameters<typeof trialScore>[0] = { id: 'trial', execution: 'completed', hostWork: 'settled',
      stop: { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason: 'Fixture closed', detail: 'Offline fixture' },
      status: evaluation.status, evaluation };
    return { report, atomic: nested ? evaluation.checks.quality!.children![0]! : evaluation.checks.quality! };
  }
  return { measure, runtime, provider };
}

it.each(['fail', 'unknown'] as const)('rejects atomic acceptance-gate infrastructure errors before reward (%s)', async missing => {
  for (const mode of ['plain', 'sibling', 'passing-gate'] as const) for (const nested of [false, true]) {
    const f = fixture(missing);
    const { report, atomic } = await f.measure(mode, nested);
    expect(report.status).toBe(mode === 'plain' ? 'error' : mode === 'sibling' ? 'fail' : 'pass');
    expect(atomic).toMatchObject({ status: 'error', atomicFailure: { cause: 'acceptance-gate', gateId: 'accepted' },
      children: [{ id: 'accepted', status: 'error', judgeFailure: { cause: 'unclassified' } }],
      judgeCalls: [{ outcome: 'generation-error', providerId: 'offline-subscription' }] });
    expect(atomic.score).toBeUndefined();
    expect(atomic.atomicGrading).toBeUndefined();
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
    expect(f.runtime.extract).not.toHaveBeenCalled();
    expect(f.runtime.backend.identity).not.toHaveBeenCalled();
    expect(f.runtime.backend.score).not.toHaveBeenCalled();
    expect(() => trialScore(report)).toThrow('unscorable');
  }
});

it.each(['fail', 'unknown'] as const)('keeps genuine passing and failing acceptance judgments scorable (%s)', async missing => {
  for (const composition of [undefined, 'all', 'any'] as const) for (const outcome of ['pass', 'fail'] as const) {
    const f = fixture(missing, outcome, composition);
    const expected = composition === 'all' ? 'fail' : composition === 'any' ? 'pass' : outcome;
    const { report, atomic } = await f.measure('plain', true);
    expect(atomic.status).toBe(expected);
    expect(atomic.atomicFailure).toBeUndefined();
    expect(trialScore(report)).toBe(expected === 'pass' ? 1 : 0);
    expect(f.runtime.extract).toHaveBeenCalledTimes(expected === 'pass' ? 1 : 0);
  }
});

it.each(['fail', 'unknown'] as const)('rejects judge errors masked inside composite acceptance gates (%s)', async missing => {
  for (const composition of ['all', 'any'] as const) for (const mode of ['plain', 'sibling', 'passing-gate'] as const) for (const nested of [false, true]) {
    const f = fixture(missing, 'error', composition);
    const { report, atomic } = await f.measure(mode, nested);
    expect(atomic.children![0]!.status).toBe(composition === 'all' ? 'fail' : 'pass');
    expect(atomic.children![0]!.children![0]).toMatchObject({ status: 'error', judgeFailure: { cause: 'unclassified' } });
    expect(atomic).toMatchObject({ status: 'error', atomicFailure: { cause: 'acceptance-gate', gateId: 'accepted' },
      judgeCalls: [{ outcome: 'generation-error', providerId: 'offline-subscription' }] });
    expect(atomic.score).toBeUndefined();
    expect(atomic.atomicGrading).toBeUndefined();
    expect(f.runtime.extract).not.toHaveBeenCalled();
    expect(f.runtime.backend.identity).not.toHaveBeenCalled();
    expect(f.runtime.backend.score).not.toHaveBeenCalled();
    expect(() => trialScore(report)).toThrow('unscorable');
  }
});
