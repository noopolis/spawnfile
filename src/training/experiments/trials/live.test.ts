import { expect, it } from 'vitest';
import { createLiveMonitor } from './live.js';
import { createEvaluationRegistry, result } from '../../evaluation/index.js';
import { artifact, snapshot } from '../../testing/index.js';
import type { TrialReport } from './types.js';

it('resolves selected closed mechanical failures before starting any terminal advisory cognition', async () => {
  for (const reverse of [false, true]) {
    let judgments = 0; let stopped = false;
    const registry = createEvaluationRegistry({ advice: {
      definition: { version: '1', kind: 'semantic', incremental: true, stopProof: false, validate() {} },
      evaluate: async () => { judgments++; return result('pass', 'unused'); },
    } });
    const checks = [{ id: 'advice', on: 'event' as const, eval: 'advice' },
      { id: 'required', on: 'event' as const, on_fail: 'stop' as const, eval: 'equals', input: 'output.text', value: 'expected' }];
    const monitor = createLiveMonitor({ checks: reverse ? checks.reverse() : checks, registry,
      evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
      persist: async () => {}, stop: () => { stopped = true; } });
    await monitor.close(snapshot());
    expect(stopped).toBe(true); expect(judgments).toBe(0); expect(monitor.decisive!.status).toBe('fail');
  }
});

it('evaluates each immutable artifact version once and closes missing selected scopes honestly', async () => {
  const entries: TrialReport['live'] = [];
  const monitor = createLiveMonitor({
    checks: [{ id: 'json', on: { artifact: 'article' }, on_fail: 'continue', all: [
      { not: { any: [{ eval: 'equals', input: 'artifact:article#/body', value: 'wrong' }] } }] },
    { id: 'missing', on: { artifact: 'absent' }, on_fail: 'stop', eval: 'equals', input: 'artifact:absent', value: 'required' }],
    registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
    persist: async entry => { entries.push(entry); }, stop: () => { throw new Error('No decisive failure expected'); },
  });
  await monitor.checkpoint(snapshot({ closed: false, artifacts: {} }), 'none');
  expect(entries).toHaveLength(0);
  await monitor.checkpoint(snapshot({ closed: false }), 'version1');
  await monitor.checkpoint(snapshot({ closed: false }), 'same');
  expect(entries).toHaveLength(1);
  await monitor.checkpoint(snapshot({ closed: false, artifacts: { article: { ...artifact(), digest: 'new' } } }), 'version2');
  expect(entries).toHaveLength(2);
  const selected = await monitor.close(snapshot());
  expect(selected[0]!.status).toBe('unknown'); expect(selected[0]!.finality).toBe('final');
  expect(entries.at(-1)!.boundary).toBe('closed');
});
it('propagates failed asynchronous advisory persistence as infrastructure, never as a subject violation', async () => {
  let stopped = false;
  const registry = createEvaluationRegistry({ advice: {
    definition: { version: '1', kind: 'semantic', incremental: true, stopProof: false, validate() {} },
    evaluate: async () => result('fail', 'rough'),
  } });
  const monitor = createLiveMonitor({ checks: [{ id: 'advice', on: 'event', any: [{ not: { eval: 'advice' } }] }],
    registry, evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
    persist: async () => { throw new Error('journal failed'); }, stop: () => { stopped = true; },
  });
  await monitor.checkpoint(snapshot({ closed: false }), 'open');
  await expect(monitor.close(snapshot())).rejects.toThrow('journal failed');
  expect(stopped).toBe(false);
});

it('rejects semantic stop authority at construction and freezes the selected policy', async () => {
  const registry = createEvaluationRegistry();
  const base = { registry, evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
    persist: async () => {}, stop: () => { throw new Error('Semantic stop'); } };
  expect(() => createLiveMonitor({ ...base, checks: [{ id: 'bad', on: 'event', on_fail: 'stop', eval: 'llm-rubric' }] })).toThrow('mechanical');
  const check = { id: 'original', on: 'event' as const, on_fail: 'continue' as const, eval: 'equals', input: 'output.text', value: '4' };
  const monitor = createLiveMonitor({ ...base, checks: [check] });
  check.value = 'changed';
  await monitor.checkpoint(snapshot(), 'closed');
  expect(monitor.history[0]!.result.status).toBe('pass');
});
