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
