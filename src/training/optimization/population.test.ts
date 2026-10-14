import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OptimizationCheckpoint, readDspyCheckpointEvidence } from './checkpoint.js';
import { runDspyOptimization } from './runner.js';
import { simulatedOptions } from './testSupport.js';
import type { DspyGenerateParams } from './protocol.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function populationOptions() {
  const { options } = simulatedOptions();
  const evaluated: string[] = [], generated: DspyGenerateParams[] = [];
  options.components = { 'AGENTS.md': 'Always gather evidence before answering. Cite the sources.' };
  options.search = { variants: 2, keep: 1, rounds: 2, selection: 'pareto', rewriteShare: 0.5,
    minChange: 0.08, hypothesisSimilarity: 0.6, patience: 2, boundaries: [] };
  options.editScope = { 'AGENTS.md': 'whole-file' };
  options.budget = { maxMetricCalls: 30, maxProposals: 12 };
  options.validationCaseIds = ['validation-a', 'validation-b'];
  let nextConcept = 0;
  options.generate = async (request, _signal, callbackId) => {
    generated.push(request);
    const payload = JSON.parse(request.messages[1]!.content) as {
      phase: string; strategies: Array<'rewrite' | 'refine'>;
      plannedHypothesis: { hypothesis: string; targetedCriteria: string[] };
    };
    const concepts = ['Compare contrasting source accounts', 'Enforce strict quotation attribution',
      'Rank uncertainty by confidence categories', 'Apply explicit chronology checks'];
    const text = payload.phase === 'planning'
      ? { hypotheses: payload.strategies.map(strategy => {
        const concept = concepts[nextConcept++];
        return { strategy, hypothesis: concept, targetedCriteria: ['quality'], plan: concept };
      }) }
      : { components: { 'AGENTS.md': `${payload.plannedHypothesis.hypothesis}.\nNever invent claims.\nOnly publish verified evidence for ${callbackId}.` },
        hypothesis: payload.plannedHypothesis.hypothesis, expectedImpact: [{ criterion: 'quality', effect: 'Improve evidence precision.' }] };
    return { text: JSON.stringify(text), model: 'simulated-subscription', usage: null, route: 'simulated-subscription' };
  };
  options.evaluate = async (request, _signal, callbackId) => {
    evaluated.push(callbackId!);
    const rank = request.components['AGENTS.md']!.includes('Always gather') ? 0 :
      request.components['AGENTS.md']!.includes('Compare contrasting') ? 0.4 :
      request.components['AGENTS.md']!.includes('Enforce strict') ? 0.6 :
      request.components['AGENTS.md']!.includes('Rank uncertainty') ? 0.8 : 1;
    return { score: rank, feedback: request.split === 'train' ? '{"criteria":{"quality":0}}' : '',
      output: request.split === 'train' ? 'observed answer' : '', captureId: `capture-${callbackId}` };
  };
  return { options, evaluated, generated };
}

it('runs the real population bridge with complete host-verified validation and deterministic rounds', async () => {
  const run = populationOptions();
  const result = await runDspyOptimization(run.options);
  expect(result.provenance.optimizer).toBe('paideia.population');
  expect(result.provenance.rounds?.map(round => round.variants.length)).toEqual([0, 2, 2]);
  expect(result.provenance.rounds?.every(round => round.kept.length === 1)).toBe(true);
  expect(result.provenance.candidates).toHaveLength(5);
  expect(result.provenance.selectedCandidateIndex).toBe(4);
  expect(result.provenance.candidates[4]?.perCaseScores).toEqual({ 'validation-a': 1, 'validation-b': 1 });
  expect(result.provenance.editScope).toEqual(run.options.editScope);
  expect(run.generated).toHaveLength(6);
  expect(run.evaluated).toHaveLength(15);
  expect(run.generated.every(call => JSON.parse(call.messages[1]!.content).boundaries.length === 0)).toBe(true);
  expect(await runDspyOptimization(populationOptions().options)).toEqual(result);
});

it('supplies public atomic failures and article excerpts to real-process proposers without held-out text', async () => {
  const run = populationOptions();
  run.options.search = { ...run.options.search!, variants: 1, keep: 1, rounds: 1 };
  const evaluate = run.options.evaluate;
  run.options.evaluate = async (...args) => {
    const measured = await evaluate(...args);
    if (args[0].split !== 'train') return measured;
    return { ...measured, output: 'Article excerpt: the attribution is missing.', feedback: JSON.stringify({
      evaluation: { stages: [{ id: 'writing', checks: [{ id: 'attribution', status: 'fail', score: 0.1,
        atomic: { failed_check_count: 1, omitted_failed_checks: 0,
          failed_checks: [{ template: 'named-source', unit: 'The source was not identified.', probability: 0.1 }] } }] }] },
    }) };
  };
  const result = await runDspyOptimization(run.options);
  expect(result.provenance.candidates).toHaveLength(2);
  expect(run.generated).toHaveLength(2);
  for (const request of run.generated) {
    const payload = JSON.parse(request.messages[1]!.content);
    expect(payload.trainingFeedback.entries[0].feedback.evaluation.stages[0].checks[0].atomic.failed_checks[0])
      .toEqual({ template: 'named-source', unit: 'The source was not identified.', probability: 0.1 });
    expect(payload.trainingFeedback.entries[0].output).toContain('Article excerpt:');
    expect(request.messages[1]!.content).not.toMatch(/validation-a|validation-b/);
    expect(Buffer.byteLength(JSON.stringify(payload.trainingFeedback))).toBeLessThanOrEqual(65536);
  }
});

it('overlaps four real-process population callbacks and binds scores after reverse completion', async () => {
  const run = populationOptions();
  run.options.concurrency = 4;
  run.options.trainCaseIds = ['t0', 't1', 't2', 't3'];
  run.options.validationCaseIds = ['v0', 'v1', 'v2', 'v3'];
  run.options.budget.maxMetricCalls = 40;
  const evaluate = run.options.evaluate;
  const completed: string[] = [];
  const pending = new Map<number, () => void>();
  let active = 0, peak = 0;
  run.options.evaluate = async (request, signal, callbackId) => {
    const reply = await evaluate(request, signal, callbackId);
    active++;
    peak = Math.max(peak, active);
    expect(active).toBeLessThanOrEqual(4);
    const index = Number(request.caseId[1]);
    await new Promise<void>(resolve => {
      pending.set(index, resolve);
      if (pending.size === 4) pending.get(3)!();
    });
    active--;
    completed.push(request.caseId);
    if (index > 0) pending.get(index - 1)!();
    else pending.clear();
    return { ...reply, score: reply.score / 2 + index / 8 };
  };
  const result = await runDspyOptimization(run.options);
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(pending.size).toBe(0);
  expect(run.evaluated).toHaveLength(40);
  expect(completed.slice(0, 4)).toEqual(['v3', 'v2', 'v1', 'v0']);
  expect(completed.slice(4, 8)).toEqual(['t3', 't2', 't1', 't0']);
  expect(result.provenance.candidates[0]?.perCaseScores).toEqual({ v0: 0, v1: 0.125, v2: 0.25, v3: 0.375 });
  expect(result.provenance.candidates[4]?.perCaseScores).toEqual({ v0: 0.5, v1: 0.625, v2: 0.75, v3: 0.875 });
  expect(result.provenance.selectedCandidateIndex).toBe(4);
});

it('reconstructs mid-round population state from settled callbacks without extra spend or Python pickle', async () => {
  const expected = await runDspyOptimization(populationOptions().options);
  const run = populationOptions();
  const directory = await mkdtemp(join(tmpdir(), 'paideia-population-')); roots.push(directory);
  run.options.checkpoint = { directory, resume: false, identity: 'population-fixture' };
  const complete = OptimizationCheckpoint.prototype.complete;
  let interrupt = true;
  const spy = vi.spyOn(OptimizationCheckpoint.prototype, 'complete').mockImplementation(async function (this: OptimizationCheckpoint, ...args) {
    await complete.apply(this, args);
    if (interrupt && args[0].request.method === 'generate') { interrupt = false; throw new Error('settled mid-round interruption'); }
  });
  await expect(runDspyOptimization(run.options)).rejects.toThrow('settled mid-round interruption');
  spy.mockRestore();
  run.options.checkpoint.resume = true;
  expect(await runDspyOptimization(run.options)).toEqual(expected);
  expect(run.generated).toHaveLength(6);
  expect(run.evaluated).toHaveLength(15);
  const journal = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'));
  expect(journal.entries.every((entry: { attempts: number }) => entry.attempts === 1)).toBe(true);
  expect(new Set(run.evaluated).size).toBe(run.evaluated.length);
  await expect(readFile(join(directory, 'optimizer.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const restored = await readDspyCheckpointEvidence({ ...run.options, checkpoint: run.options.checkpoint });
  expect(restored.generations).toHaveLength(6);
  await expect(readDspyCheckpointEvidence({ ...run.options, checkpoint: run.options.checkpoint,
    search: { ...run.options.search!, minChange: 0.09 } })).rejects.toThrow('identity');
});

it('fails closed on an unsettled population callback before any resumed host spend', async () => {
  const run = populationOptions();
  const directory = await mkdtemp(join(tmpdir(), 'paideia-population-pending-')); roots.push(directory);
  run.options.checkpoint = { directory, resume: false, identity: 'pending-fixture' };
  const generate = run.options.generate;
  run.options.generate = async () => { throw new Error('uncertain generation'); };
  await expect(runDspyOptimization(run.options)).rejects.toThrow('uncertain generation');
  const before = await readFile(join(directory, 'host.json'), 'utf8');
  run.options.generate = generate;
  run.options.checkpoint.resume = true;
  await expect(runDspyOptimization(run.options)).rejects.toThrow('cannot replay uncertain or failed callback');
  expect(await readFile(join(directory, 'host.json'), 'utf8')).toBe(before);
  expect(run.generated).toHaveLength(0);
  expect(run.evaluated).toHaveLength(3);
});

it('verifies seeded multi-parent rounds independently of parent visitation order', async () => {
  const run = populationOptions();
  run.options.search!.keep = 2;
  run.options.seed = 1;
  const result = await runDspyOptimization(run.options);
  expect(result.provenance.rounds?.map(round => round.kept.length)).toEqual([1, 2, 2]);
  expect(result.provenance.rounds?.[2]?.parents).not.toEqual(result.provenance.rounds?.[1]?.kept);
  expect(result.provenance.rounds?.[2]?.parents.toSorted()).toEqual(result.provenance.rounds?.[1]?.kept.toSorted());
  expect(new Set(result.provenance.rounds?.[2]?.variants.map(slot => slot.parent)).size).toBe(2);
  expect(result.provenance.candidates).toHaveLength(5);
  expect(run.generated).toHaveLength(7);
  expect(run.evaluated).toHaveLength(15);
});

it.each([
  { maxMetricCalls: 30, maxProposals: 5 },
  { maxMetricCalls: 3, maxProposals: 12 },
  { maxMetricCalls: 5, maxProposals: 12 },
  { maxMetricCalls: 8, maxProposals: 12 },
])('verifies actual budget stops and empty multi-parent slots: %o', async budget => {
  const run = populationOptions();
  run.options.search!.keep = 2;
  run.options.budget = budget;
  const result = await runDspyOptimization(run.options);
  expect(result.provenance.stopReason).toBe('budget');
  expect(result.provenance.evaluations).toBeLessThanOrEqual(budget.maxMetricCalls);
  expect(result.provenance.proposals).toBeLessThanOrEqual(budget.maxProposals);
});


it('refuses unenforceable hard boundaries before callbacks or bridge execution', async () => {
  const run = populationOptions();
  run.options.search!.boundaries = ['Never publish unverified claims.'];
  run.options.bridge.command = '/nonexistent-bridge-must-not-start';
  await expect(runDspyOptimization(run.options)).rejects.toThrow('Unsupported hard boundary');
  expect(run.generated).toHaveLength(0);
  expect(run.evaluated).toHaveLength(0);
});


it.each([false, true])('enforces declared boundaries through the real bridge (violation=%s)', async violation => {
  const run = populationOptions();
  run.options.search!.boundaries = ['forbid-text ["AGENTS.md", "Never invent claims."]'];
  const generate = run.options.generate;
  if (!violation) run.options.generate = async (...args) => {
    const reply = await generate(...args);
    return { ...reply, text: reply.text.replaceAll('Never invent claims.', 'Always verify claims.') };
  };
  const result = await runDspyOptimization(run.options);
  expect(result.provenance.candidates).toHaveLength(violation ? 1 : 5);
  expect(run.evaluated).toHaveLength(violation ? 3 : 15);
  expect(result.provenance.rounds!.slice(1).flatMap(round => round.variants)
    .every(slot => slot.rejectionReason === (violation ? 'hard-boundary' : null))).toBe(true);
  expect(run.generated.every(call => JSON.parse(call.messages[1]!.content).boundaries
    .includes(run.options.search!.boundaries[0]))).toBe(true);
});
