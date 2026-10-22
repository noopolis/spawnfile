import { expect, it, vi } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../cases/index.js';
import { createEvaluationRegistry, evaluatePlan, result } from '../evaluation/index.js';
import { evaluationContext } from '../testing/index.js';
import type { TrainingOptions } from './training/training.js';
import { fixture } from './replay/fixture.js';
import { repairMeasurement, type RepairedMeasurement } from './repair/index.js';
import { verifyCapturedRecord } from './repair/record.js';
import { InferenceFailure } from '../inference/index.js';

async function setup(change?: Parameters<typeof fixture>[0], nested?: 'all' | 'any' | 'not') {
  const dataset = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: original
checks:
  - {id: quality, eval: llm-rubric, input: output.text, judge: editor, rubric: {prompt: Grade}, minimum: 0.8}
  - {id: retained, eval: contains-any, input: output.text, values: [ARTICLE]}
records: [{id: story, input: {prompt: Original}}]
`), { registry: { judges: { editor: { version: 'fixed' } } } });
  if (nested) {
    const stage = dataset.records[0]!.effectiveStages[0]!;
    const leaf = stage.checks[0]!;
    stage.checks[0] = nested === 'not' ? { id: 'quality', not: { ...leaf, id: 'inner' } }
      : { id: 'quality', [nested]: [{ ...leaf, id: 'inner' },
        { id: 'other', eval: 'equals', input: 'output.text', value: nested === 'all' ? 'ARTICLE' : 'absent' }] };
  }
  let broken = true;
  const generate = vi.fn(async () => {
    if (broken) throw new InferenceFailure('protocol', 'Original invalid response');
    return { text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Observed'], citations: [{ source: 'input', quote: 'ARTICLE' }] }),
      model: 'actual', route: 'fixture', usage: null };
  });
  const evaluation = evaluationContext({ judges: { editor: { model: 'requested', provider: { id: 'fixture', generate,
    capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false } } } } });
  evaluation.snapshot.output = 'ARTICLE';
  const original = await evaluatePlan(dataset.records[0]!.effectiveStages, evaluation, createEvaluationRegistry());
  const f = await fixture(report => {
    report.status = 'error'; report.evaluation = JSON.parse(JSON.stringify(original)); report.stop!.quiescence = 'confirmed'; change?.(report);
  });
  await f.store.putBlob('trial', JSON.stringify(dataset.records[0]), 'evaluator');
  broken = false; generate.mockClear();
  const reserve = vi.fn(async () => 'repair-1');
  const options = { native: { store: f.store, registry: f.options.registry } } as TrainingOptions;
  const input = { options, dataset, report: f.report, evaluation, reserve };
  return { ...f, input, generate, dataset };
}

it('appends only the failed measurement, restores reserved completion, and retains valid decisions', async () => {
  const f = await setup(), observer = vi.fn(); f.input.evaluation.observeJudgeAttempt = observer;
  const repaired = await repairMeasurement(f.input, 'receipt');
  expect(repaired!.status).toBe('pass'); expect(f.generate).toHaveBeenCalledTimes(1);
  expect(repaired!.evaluation.checks.retained).toEqual(f.report.evaluation.checks.retained);
  expect(observer).toHaveBeenCalledTimes(1);
  expect(await repairMeasurement({ ...f.input, pendingRescoreId: repaired!.id }, 'receipt')).toEqual(repaired);
  expect(await repairMeasurement({ ...f.input, previous: repaired }, 'receipt')).toEqual(repaired);
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.input.reserve).toHaveBeenCalledTimes(1);
  const passing = await setup(report => { report.status = 'pass'; });
  expect(await repairMeasurement(passing.input, 'receipt')).toBeUndefined();
  expect(passing.generate).not.toHaveBeenCalled();
});

it('does not infer closure, migrate sealed tests, change recorded criteria or rerun per-turn plans', async () => {
  const f = await setup();
  await expect(repairMeasurement({ ...f.input, report: { ...f.report, phase: 'test' } }, 'receipt')).rejects.toThrow('sealed-test');
  await expect(repairMeasurement({ ...f.input, report: { ...f.report, error: 'changed' } }, 'receipt')).rejects.toThrow('verified closed');
  const incomplete = await setup(report => { report.hostWork = 'incomplete'; });
  await expect(repairMeasurement(incomplete.input, 'receipt')).rejects.toThrow('verified closed');
  const unknown = await setup(report => { report.stop!.quiescence = 'unknown'; });
  await expect(repairMeasurement(unknown.input, 'receipt')).rejects.toThrow('verified closed');
  await expect(repairMeasurement({ ...f.input, dataset: { ...f.dataset, records: [] } }, 'receipt')).rejects.toThrow('final plans');
  const record = structuredClone(f.dataset.records[0]!);
  record.turns = [{ id: 'step', input: { prompt: 'step' }, checks: [{ eval: 'contains-any', input: 'output.text', values: ['x'] }] }];
  await expect(repairMeasurement({ ...f.input, dataset: { ...f.dataset, records: [record] } }, 'receipt')).rejects.toThrow('final plans');
  expect(f.generate).not.toHaveBeenCalled(); expect(f.input.reserve).not.toHaveBeenCalled();
});

it('rejects altered or absent historical error bindings and never overwrites a decisive native failure', async () => {
  const f = await setup(report => { report.decisiveFailure = JSON.parse(JSON.stringify(result('fail', 'Native mechanical violation'))); });
  const repaired = await repairMeasurement(f.input, 'receipt');
  expect(repaired!.status).toBe('fail'); expect(repaired!.evaluation.status).toBe('pass');
  const prior = structuredClone(repaired!); prior.status = 'error'; prior.criteria.stages = [];
  await expect(repairMeasurement({ ...f.input, previous: prior }, 'receipt')).rejects.toThrow('criteria changed');
  prior.criteria.stages = f.dataset.records[0]!.effectiveStages;
  await expect(repairMeasurement({ ...f.input, previous: prior }, 'receipt')).rejects.toThrow('no failed inference');
  prior.evaluation.stages = [];
  await expect(repairMeasurement({ ...f.input, previous: prior }, 'receipt')).rejects.toThrow('stage is incomplete');
});

it('keeps cancellation and audit failures explicit rather than publishing a successful repair', async () => {
  const f = await setup();
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await expect(repairMeasurement({ ...f.input, signal: controller.signal }, 'receipt')).rejects.toThrow('cancelled');
  const second = await setup();
  second.input.evaluation.observeJudgeAttempt = () => { throw new Error('Observer unavailable'); };
  const failed = await repairMeasurement(second.input, 'receipt');
  expect(failed!.status).toBe('error'); expect(second.generate).toHaveBeenCalledTimes(1);
});

it('finds exactly one immutable record through protected blobs and ignores unrelated data', async () => {
  const f = await setup();
  await f.store.putBlob('trial', 'not JSON', 'evaluator');
  await f.store.putBlob('trial', JSON.stringify(null), 'evaluator');
  await f.store.putBlob('trial', JSON.stringify({ id: 'elsewhere', effectiveStages: [] }), 'evaluator');
  const access = { audience: 'evaluator' as const, phase: 'training' as const };
  expect(await verifyCapturedRecord(f.store, 'trial', access, f.dataset.records[0]!)).toEqual(JSON.parse(JSON.stringify(f.dataset.records[0])));
  const changed = structuredClone(f.dataset.records[0]!); changed.input = { prompt: 'Changed' };
  await expect(verifyCapturedRecord(f.store, 'trial', access, changed)).rejects.toThrow('criteria differ');
  await f.store.putBlob('trial', JSON.stringify(changed), 'evaluator');
  await expect(verifyCapturedRecord(f.store, 'trial', access, f.dataset.records[0]!)).rejects.toThrow('criteria differ');
});


it.each(['all', 'any', 'not'] as const)('repairs nested %s leaves and binds complete original child topology', async nested => {
  const f = await setup(undefined, nested);
  f.input.evaluation.embeddings = { fixture: { id: 'embedding', version: 'v1', embed: async () => ({ vectors: [], usage: null }) } };
  const repaired = await repairMeasurement(f.input, 'receipt');
  expect(repaired!.status).toBe(nested === 'not' ? 'fail' : 'pass');
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect((repaired as RepairedMeasurement).repair.errorPaths).toEqual([`/stages/0/checks/0/${nested}${nested === 'not' ? '' : '/0'}`]);
  const previous = structuredClone(repaired!); previous.status = 'error';
  previous.evaluation = structuredClone(f.report.evaluation);
  previous.evaluation.stages[0]!.checks[0]!.children = [];
  await expect(repairMeasurement({ ...f.input, previous }, 'receipt')).rejects.toThrow('tree is incomplete');
  expect(f.generate).toHaveBeenCalledTimes(1);
});


it('rejects unsupported mechanical and judge-less errors before spending recovery budget or invoking inference', async () => {
  const noJudge = await setup(report => { report.evaluation.stages[0]!.checks[0]!.judgeCalls = []; });
  await expect(repairMeasurement(noJudge.input, 'receipt')).rejects.toThrow('failed semantic inference');
  expect(noJudge.input.reserve).not.toHaveBeenCalled(); expect(noJudge.generate).not.toHaveBeenCalled();
  const mechanical = await setup();
  const evaluator = mechanical.input.options.native.registry['llm-rubric']!;
  mechanical.input.options.native.registry = { ...mechanical.input.options.native.registry,
    'llm-rubric': { ...evaluator, definition: { ...evaluator.definition, kind: 'mechanical' } } };
  await expect(repairMeasurement(mechanical.input, 'receipt')).rejects.toThrow('failed semantic inference');
  expect(mechanical.input.reserve).not.toHaveBeenCalled(); expect(mechanical.generate).not.toHaveBeenCalled();
});
