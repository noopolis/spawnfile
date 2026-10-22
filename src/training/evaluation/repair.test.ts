import { expect, it, vi } from 'vitest';
import type { Stage } from '../contracts/dataset.js';
import type { EvaluationResult, JudgeCall } from '../contracts/evaluation.js';
import { evaluationContext } from '../testing/index.js';
import { createEvaluationRegistry, evaluatePlan, result } from './index.js';

const errorPath = '/stages/0/checks/0/all/1';
const call = (id: string, failed = false): JudgeCall => ({ id, judge: 'editor', providerId: 'fixture',
  requestedModel: 'model', responseModel: 'model', responseRoute: 'fixture',
  outcome: failed ? 'generation-error' : 'completed', ...(failed ? { failureKind: 'protocol' as const } : {}), usage: null });
function fixture() {
  let failed = true;
  const observed = vi.fn();
  const semantic = vi.fn(async (node: { id?: string }): Promise<EvaluationResult> => {
    if (node.id === 'broken' && failed) return { ...result('error', 'Original protocol failure'), id: node.id, judgeCalls: [call('old-error', true)] };
    const score = node.id === 'quality' ? 0.88 : 0.95;
    return { ...result(node.id === 'retained-fail' ? 'fail' : 'pass', `Measured ${node.id}`), score,
      evidence: [{ kind: 'artifact', id: 'source' }], judgeCalls: [call(node.id === 'broken' ? 'new-repair' : node.id!)] };
  });
  const registry = createEvaluationRegistry({ measured: { definition: { version: '1', kind: 'semantic',
    incremental: false, stopProof: false, validate() {} }, evaluate: semantic } });
  const stages: Stage[] = [{ id: 'writing', checks: [
    { id: 'bundle', all: [{ id: 'quality', eval: 'measured' }, { id: 'broken', eval: 'measured' }] },
    { id: 'retained-fail', eval: 'measured' },
  ], score: { linear: { bundle: 2, 'retained-fail': 1 } }, gate: { passed: 'bundle' } },
  { id: 'release', when: { passed: 'writing' }, checks: [{ id: 'known', eval: 'measured' }], gate: { passed: 'known' } }];
  const context = evaluationContext({ observeJudgeAttempt: observed });
  return { registry, stages, context, semantic, observed, recover() { failed = false; } };
}

it('repairs only the authorized nested error and preserves valid pass/fail evidence exactly', async () => {
  const f = fixture(), original = await evaluatePlan(f.stages, f.context, f.registry);
  const before = structuredClone(original), stages = structuredClone(f.stages);
  f.semantic.mockClear(); f.recover();
  const repaired = await evaluatePlan(f.stages, f.context, f.registry, { originalStages: stages, original, errorPaths: [errorPath] });
  expect(f.semantic.mock.calls.map(([node]) => node.id)).toEqual(['broken']);
  expect(repaired.stages[0]!.checks[0]!.children![0]).toEqual(original.stages[0]!.checks[0]!.children![0]);
  expect(repaired.checks['retained-fail']).toEqual(original.checks['retained-fail']);
  expect(repaired.checks.bundle!.status).toBe('pass');
  expect(repaired.scores.writing!.lower).toBeCloseTo((2 + 0.95) / 3);
  expect(repaired.stages[0]!.gate.status).toBe('pass');
  expect(repaired.checks.known!.status).toBe('skipped');
  expect(repaired.judgeCalls!.map(item => item.id)).toEqual(['quality', 'new-repair', 'retained-fail']);
  expect(original).toEqual(before); expect(f.stages).toEqual(stages);
});

it('rejects changed criteria and attempts to reroll valid, missing or duplicate leaf paths before inference', async () => {
  const f = fixture(), original = await evaluatePlan(f.stages, f.context, f.registry);
  f.semantic.mockClear();
  const run = (errorPaths: string[], originalStages = f.stages) => evaluatePlan(f.stages, f.context, f.registry, { originalStages, original, errorPaths });
  await expect(run(['/stages/0/checks/0/all/0'])).rejects.toThrow('resolved pass/fail');
  await expect(run(['/stages/0/checks/1'])).rejects.toThrow('resolved pass/fail');
  await expect(run(['/stages/99/checks/0'])).rejects.toThrow('unknown error leaf');
  await expect(run([errorPath, errorPath])).rejects.toThrow('unique');
  await expect(run([])).rejects.toThrow('unique');
  const changed = structuredClone(f.stages); changed[0]!.score!.linear.bundle = 99;
  await expect(run([errorPath], changed)).rejects.toThrow('changed the original plan');
  expect(f.semantic).not.toHaveBeenCalled();
});

it('rejects malformed original topology, provisional results and uncaptured stage evaluators', async () => {
  const f = fixture(), original = await evaluatePlan(f.stages, f.context, f.registry);
  f.semantic.mockClear();
  const run = (prior = structuredClone(original), stages = f.stages) => evaluatePlan(stages, f.context, f.registry,
    { originalStages: stages, original: prior, errorPaths: [errorPath] });
  let changed = structuredClone(original); changed.stages.pop();
  await expect(run(changed)).rejects.toThrow('stage bindings');
  changed = structuredClone(original); changed.stages[0]!.id = 'wrong';
  await expect(run(changed)).rejects.toThrow('stage bindings');
  changed = structuredClone(original); changed.stages[0]!.checks[0]!.children!.pop();
  await expect(run(changed)).rejects.toThrow('child bindings');
  changed = structuredClone(original); changed.stages[0]!.checks[0]!.children![1]!.finality = 'provisional';
  await expect(run(changed)).rejects.toThrow('check binding');
  changed = structuredClone(original); changed.stages[0]!.checks[0]!.children![1]!.judgeCalls = [];
  await expect(run(changed)).rejects.toThrow('failed semantic');
  const stages = structuredClone(f.stages); stages[0]!.gate = { eval: 'measured' };
  await expect(run(original, stages)).rejects.toThrow('reference-only');
  expect(f.semantic).not.toHaveBeenCalled();
});
