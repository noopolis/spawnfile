import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as optimization from '../../optimization/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { cliFixture } from '../fixture.js';
import { main } from '../commands.js';
import type { TrainingReport } from '../../experiments/index.js';
import { loadInvocationViewer } from '../viewer.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([undefined, 'zero', 'stage-score'] as const)('threads YAML deferred scoring through callbacks, held-out and export (%s)', async deferred => {
  const f = await cliFixture(); roots.push(f.root);
  const dataset = (id: string, records: string[]) => ({ schema: 'paideia.dataset.v1', id,
    stages: [{ id: 'article', checks: [{ id: 'filed', eval: 'equals', input: 'output.text', value: 'BAD' }],
      gate: { passed: 'filed' }, score: { linear: { filed: 1 } } }],
    records: records.map(id => ({ id, group: id, input: { prompt: 'Write' } })),
  });
  await writeFile(join(f.root, 'train.yaml'), JSON.stringify({ ...dataset('train', ['a', 'b']), training: {
    models: { reflect: { provider: 'ollama', model: 'offline' } }, optimizer: { model: 'reflect' },
    ...(deferred ? { scoring: { deferred } } : {}),
  } }));
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify(dataset('test', ['c'])));
  const expected = deferred === 'stage-score' ? 1 : 0;
  const optimize = vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    const captures = [];
    for (const split of ['train', 'validation'] as const) {
      const caseId = (split === 'train' ? request.trainCaseIds : request.validationCaseIds)[0]!;
      const measured = await request.evaluate({ caseId, split, components: request.components }, new AbortController().signal);
      expect(measured.score).toBe(expected);
      captures.push({ caseId, split, captureId: measured.captureId });
    }
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components: request.components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 2, proposals: 0,
        selectedCandidateIndex: 0, candidates: [{ components: request.components, parents: [null], validationScore: expected, discoveryEvaluations: 0 }],
        captures, generations: [] } };
  });
  const adapter = f.dependencies.adapter!;
  const code = await main(['train', '--train', 'train.yaml', '--test', 'test.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md'], f.io, {
    ...f.dependencies, adapter: (runtime, options) => {
      const base = adapter(runtime, options);
      return { ...base, start: async input => {
        const session = await base.start(input);
        return { ...session, run: async (turn, signal) => ({ ...await session.run(turn, signal),
          status: 'failed', blocked: 'awaiting-external-input' }) };
      } };
    },
  });
  expect(f.stderr).toEqual([]); expect(code).toBe(1); expect(optimize).toHaveBeenCalledOnce();
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  const store = await openExperimentStore(join(f.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString()) as TrainingReport;
  expect(report.heldOut.map(value => value.meanScore)).toEqual([expected]);
  expect(report.trials.every(trial => trial.status === 'fail' && trial.execution === 'deferred')).toBe(true);
  expect(report.trials.every(trial => trial.preDeferralStatus === (deferred === 'stage-score' ? 'pass' : undefined))).toBe(true);
  expect(report.scoring).toEqual(deferred === 'stage-score' ? { deferred } : undefined);
  const exported = JSON.parse(await readFile(join(f.root, 'out/REPORT.json'), 'utf8'));
  expect(exported.candidates[0].splits.train.meanScore).toBe(expected);
  expect(exported.candidates[0].splits.test.examples[0].measurements[0]).toMatchObject({ score: expected, status: 'fail' });
  const view = await (await loadInvocationViewer(join(f.root, 'out')))();
  expect(view.trials.every(trial => trial.score === expected)).toBe(true);
});

it('preserves stage rewards in the failed invocation viewer after concurrent metric callbacks', async () => {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'train.yaml'), JSON.stringify({ schema: 'paideia.dataset.v1', id: 'train',
    stages: [{ id: 'filed', checks: [{ id: 'article', eval: 'equals', input: 'output.text', value: 'BAD' }],
      gate: { passed: 'article' }, score: { linear: { article: 1 } } }],
    records: ['a', 'b'].map(id => ({ id, group: id, input: { prompt: 'Write' } })),
    training: { models: { reflect: { provider: 'ollama', model: 'offline' } }, optimizer: { model: 'reflect' },
      scoring: { deferred: 'stage-score' } },
  }));
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify({ schema: 'paideia.dataset.v1', id: 'test',
    stages: [{ id: 'filed', checks: [{ id: 'article', eval: 'equals', input: 'output.text', value: 'BAD' }],
      gate: { passed: 'article' }, score: { linear: { article: 1 } } }], records: [{ id: 'c', group: 'c', input: { prompt: 'Write' } }],
  }));
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    await Promise.all((['train', 'validation'] as const).map(async split => {
      const caseId = (split === 'train' ? request.trainCaseIds : request.validationCaseIds)[0]!;
      const result = await request.evaluate({ caseId, split, components: request.components }, new AbortController().signal);
      expect(result.score).toBe(1);
    }));
    throw new Error('optimizer stopped after durable metrics');
  });
  const adapter = f.dependencies.adapter!;
  expect(await main(['train', '--train', 'train.yaml', '--test', 'test.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md'], f.io, {
    ...f.dependencies, adapter: (runtime, options) => {
      const base = adapter(runtime, options);
      return { ...base, start: async input => {
        const session = await base.start(input);
        return { ...session, run: async (turn, signal) => ({ ...await session.run(turn, signal),
          status: 'failed', blocked: 'awaiting-external-input' }) };
      } };
    },
  })).toBe(2);
  const view = await (await loadInvocationViewer(join(f.root, 'out')))();
  expect(view.experiment.status).toBe('failed');
  expect(view.trials).toHaveLength(2);
  expect(view.trials.every(trial => trial.score === 1 && trial.status.startsWith('fail (deferred;'))).toBe(true);
});
