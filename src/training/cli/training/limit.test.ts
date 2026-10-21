import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as optimization from '../../optimization/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { cliFixture } from '../fixture.js';
import { main } from '../commands.js';
import type { TrainingReport } from '../../experiments/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** The run52 abort: a candidate that runs out of its own declared timeout is graded, fed back and the run goes on. */
it('trains through a declared-limit stop with a zero score and budget feedback instead of an infrastructure abort', async () => {
  const f = await cliFixture(); roots.push(f.root);
  const dataset = (id: string, records: string[]) => ({ schema: 'paideia.dataset.v1', id,
    stages: [{ id: 'article', checks: [{ id: 'filed', eval: 'equals', input: 'output.text', value: 'DONE' }],
      gate: { passed: 'filed' }, score: { linear: { filed: 1 } } }],
    records: records.map(id => ({ id, group: id, input: { prompt: 'Write' } })),
  });
  await writeFile(join(f.root, 'train.yaml'), JSON.stringify({ ...dataset('train', ['a', 'b']), training: {
    models: { reflect: { provider: 'ollama', model: 'offline' } }, optimizer: { model: 'reflect' } } }));
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify(dataset('test', ['c'])));
  const optimize = vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    const captures = [];
    for (const split of ['train', 'validation'] as const) {
      const caseId = (split === 'train' ? request.trainCaseIds : request.validationCaseIds)[0]!;
      const measured = await request.evaluate({ caseId, split, components: request.components }, new AbortController().signal);
      expect(measured.score).toBe(0);
      if (split === 'train') expect(JSON.parse(measured.feedback).execution).toMatchObject({ status: 'limit-exceeded', limit: 'timeout' });
      captures.push({ caseId, split, captureId: measured.captureId });
    }
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components: request.components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 2, proposals: 0,
        selectedCandidateIndex: 0, candidates: [{ components: request.components, parents: [null], validationScore: 0, discoveryEvaluations: 0 }],
        captures, generations: [] } };
  });
  const adapter = f.dependencies.adapter!;
  const code = await main(['train', '--train', 'train.yaml', '--test', 'test.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md'], f.io, {
    ...f.dependencies, adapter: (runtime, options) => {
      const base = adapter(runtime, options);
      return { ...base, start: async input => {
        const session = await base.start(input);
        return { ...session, run: async (turn, signal) => ({ ...await session.run(turn, signal),
          status: 'failed', limit: 'timeout', error: 'Native execution failed: Grok broker turn limit_exceeded (limit_reason timeout)' }) };
      } };
    },
  });
  expect(f.stderr).toEqual([]); expect(code).toBe(1); expect(optimize).toHaveBeenCalledOnce();
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  expect(index.outcome).not.toBe('failed');
  const store = await openExperimentStore(join(f.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString()) as TrainingReport;
  expect(report.heldOut.map(value => value.meanScore)).toEqual([0]);
  expect(report.trials.every(trial => trial.status === 'fail' && trial.execution === 'limit-exceeded' && trial.limit === 'timeout')).toBe(true);
});
