import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as optimization from '../../optimization/index.js';
import { openExperimentStore } from '../../storage/index.js';
import type { TrainingReport } from '../../experiments/index.js';
import { cliFixture, datasetText, fixtureAdapter } from '../fixture.js';
import { main } from '../commands.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([0, 1, 2])('threads YAML retries through native attempt %i, exit status and local exports', async failedOrdinal => {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'train.yaml'), `${datasetText([{ id: 'a', group: 'a' }, { id: 'b', group: 'b' }])}
training:
  models: { reflect: { provider: ollama, model: offline } }
  optimizer: { model: reflect }
  budget: { trial_retries: 1, test_repeats: 2 }
  test: test.yaml
`);
  await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'c', group: 'c' }]));
  const optimize = vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    for (const split of ['train', 'validation'] as const) {
      const caseId = (split === 'train' ? request.trainCaseIds : request.validationCaseIds)[0]!;
      const result = await request.evaluate({ caseId, split, components: request.components }, new AbortController().signal, split);
      expect(result.score).toBe(1);
    }
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components: request.components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
        evaluations: 2, proposals: 0, selectedCandidateIndex: 0,
        candidates: [{ components: request.components, parents: [null], validationScore: 1, discoveryEvaluations: 0 }], captures: [], generations: [] } };
  });
  vi.spyOn(optimization, 'readDspyCheckpointEvidence').mockResolvedValue({ generations: [], failedAttempts: [], reservations: [] });
  let ordinal = 0;
  f.dependencies.adapter = runtime => {
    const adapter = fixtureAdapter(runtime, f.observedInstructions, 'pass');
    return { ...adapter, start: async input => {
      const current = ordinal++;
      const session = await adapter.start(input);
      return { ...session, run: async (turn, signal) => {
        if (current === failedOrdinal) throw new Error('wake execution claim was lost');
        return session.run(turn, signal);
      } };
    } };
  };
  const argv = ['train', '--train', 'train.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md'];
  expect(await main(argv, f.io, f.dependencies)).toBe(0);
  expect(f.stderr).toEqual([]);
  expect(ordinal).toBe(5); // Two callbacks, two held-out samples, one infrastructure failure.
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  const store = await openExperimentStore(join(f.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test',
    frozenCandidateIds: [index.candidateId] })).toString()) as TrainingReport;
  expect(report.trials).toHaveLength(5);
  expect(report.retries).toHaveLength(1);
  expect(report.retries![0]!.cause).toContain('wake execution claim was lost');
  expect(report.heldOut[0]).toMatchObject({ trialScores: [1, 1], meanScore: 1, standardError: 0 });
  const summary = JSON.parse(await readFile(join(f.root, 'out/REPORT.json'), 'utf8'));
  expect(summary.retries).toEqual(report.retries);
  for (const split of ['train', 'validation', 'test']) expect(summary.candidates[0].splits[split].meanScore).toBe(1);
  expect(await readFile(join(f.root, 'out/REPORT.md'), 'utf8')).toContain(report.retries![0]!.failedTrialId);
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(0);
  expect(ordinal).toBe(5); expect(optimize).toHaveBeenCalledOnce();
});

it.each(['eligible', 'behavior', 'worker-stop-only', 'exhausted'] as const)(
  'resumes the frozen sealed comparison under the existing retry rules: %s', async kind => {
    const f = await cliFixture(); roots.push(f.root);
    await writeFile(join(f.root, 'train.yaml'), `${datasetText([{ id: 'a', group: 'a' }, { id: 'b', group: 'b' }])}
training:
  models: { reflect: { provider: ollama, model: offline } }
  optimizer: { model: reflect }
  budget: { trial_retries: 2, test_repeats: 2 }
  test: test.yaml
`);
    await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'c', group: 'c' }]));
    const optimize = vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
      for (const split of ['train', 'validation'] as const) {
        const caseId = (split === 'train' ? request.trainCaseIds : request.validationCaseIds)[0]!;
        await request.evaluate({ caseId, split, components: request.components }, new AbortController().signal, split);
      }
      const components = Object.fromEntries(Object.entries(request.components).map(([key, value]) => [key, `${value}IMPROVED\n`]));
      return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components,
        provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
          evaluations: 2, proposals: 0, selectedCandidateIndex: 0,
          candidates: [{ components, parents: [null], validationScore: 1, discoveryEvaluations: 0 }], captures: [], generations: [] } };
    });
    vi.spyOn(optimization, 'readDspyCheckpointEvidence').mockResolvedValue({ generations: [], failedAttempts: [], reservations: [] });
    let ordinal = 0;
    f.dependencies.adapter = runtime => {
      const adapter = fixtureAdapter(runtime, f.observedInstructions, 'pass');
      return { ...adapter, start: async input => {
        const current = ordinal++;
        const session = await adapter.start(input);
        return { ...session, run: async (turn, signal) => {
          if (current < 5 || kind !== 'exhausted' && current > 6) return session.run(turn, signal);
          if (kind === 'behavior') await input.onObservation({ id: 'filed', source: 'native', seq: 1,
            type: 'tool.complete', tool: 'file_article', success: true, trialId: input.trialId, wakeId: turn.id,
            timestamp: '2026-10-18T00:00:00.000Z' });
          return { status: 'failed', text: '', usage: null, coverage: [], error: 'wake execution claim was lost',
            admission: { executionRecords: 0, executionsUsed: 0, agentExecutionsUsed: 0, tokensUsed: 0,
              agentTokensUsed: 0, toolEvents: 0, outputEvents: 0 } };
        }, stop: async reason => ({ ...await session.stop(reason),
          ...(kind === 'worker-stop-only' && current === 5 ? { quiescence: 'unknown' as const,
            containmentVerification: 'parent-container-owner' } : {}) }) };
      } };
    };
    const argv = ['train', '--train', 'train.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md', '--concurrency', '1'];
    expect(await main(argv, { ...f.io, stdout(text) {
      f.stdout.push(text);
      const event = JSON.parse(text);
      if (event.type === 'trial.finished' && event.execution === 'failed') throw new Error('controlled infrastructure abort');
    } }, f.dependencies)).toBe(2);
    expect(ordinal).toBe(6);
    const checkpoint = join(f.root, 'out/checkpoint/training.json');
    const before = JSON.parse(await readFile(checkpoint, 'utf8')).state;
    const retained = Object.values(before.entries).map(entry => (entry as { report: unknown }).report);
    expect(retained).toHaveLength(6);
    expect(before.optimizer).toBeDefined();
    f.stderr.length = 0;
    const status = await main([...argv, '--resume'], f.io, f.dependencies);
    const after = JSON.parse(await readFile(checkpoint, 'utf8')).state;
    expect(after.optimizer).toEqual(before.optimizer);
    for (const [key, entry] of Object.entries(before.entries)) expect(after.entries[key]).toEqual(entry);
    expect(optimize).toHaveBeenCalledOnce();
    if (kind === 'eligible') {
      expect(status, f.stderr.join('')).toBe(0); expect(ordinal).toBe(8);
      const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
      const store = await openExperimentStore(join(f.root, 'out'));
      const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test',
        frozenCandidateIds: [index.candidateId] })).toString()) as TrainingReport;
      expect(report.trials).toHaveLength(8);
      expect(report.retries?.map(retry => retry.attempt)).toEqual([1, 2]);
      expect(report.rescores).toBeUndefined();
      expect(report.heldOut).toHaveLength(2);
      expect(report.heldOut.every(arm => arm.trialScores?.length === 2 && arm.meanScore === 1)).toBe(true);
      expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(0);
      expect(ordinal).toBe(8);
    } else {
      expect(status).toBe(2);
      expect(ordinal).toBe(kind === 'exhausted' ? 8 : 6);
      expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(2);
      expect(ordinal).toBe(kind === 'exhausted' ? 8 : 6);
    }
  });
