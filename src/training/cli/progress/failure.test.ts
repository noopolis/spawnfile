import { afterEach, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotCandidate } from '../../candidates/index.js';
import { summarizeCosts, type TrialReport } from '../../experiments/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { cliFixture } from '../fixture.js';
import { persistResult } from '../output.js';
import { loadInvocationViewer } from '../viewer.js';
import { createFailureReport, loadFailureView } from './failure.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function trial(id: string, phase: TrialReport['phase'], candidateId: string): TrialReport {
  const coverage = [{ channel: 'usage' as const, completeness: 'complete' as const, ordering: 'source' as const }];
  return { schema: 'paideia.trial.v1', id, phase, candidateId, recordId: `${id}-case`, datasetDigest: 'dataset', planDigest: 'plan',
    paths: { root: '', workspace: '', control: '', runtimeHome: '' }, status: 'pass', execution: 'completed', hostWork: 'settled',
    snapshot: { trialId: id, recordId: `${id}-case`, closed: true, events: [], coverage,
      artifacts: {}, output: 'PRIVATE output', inputFiles: {}, context: {} },
    turns: [{ id: 'task', checks: [], native: { status: 'completed', text: 'PRIVATE output', coverage,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: null, source: 'PRIVATE provider text' } } }],
    evaluation: { status: 'pass', checks: {}, stages: [], scores: {} }, live: [] };
}

async function fixture() {
  const f = await cliFixture(); roots.push(f.root);
  const baseline = await snapshotCandidate({ sourceRoot: f.root, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'locked' }] });
  const trials = [trial('development', 'validation', baseline.id), trial('SEALED-trial', 'test', baseline.id)];
  const store = await openExperimentStore(join(f.root, 'out'));
  for (const value of trials) await store.createRun({ schema: 'paideia.run.v1', id: value.id, datasetId: 'dataset',
    candidateId: baseline.id, datasetRole: value.phase, planDigest: 'plan', recordId: value.recordId });
  const costs = summarizeCosts(trials, { subjectModel: 'gpt-5.5', optimizerGenerations: [{ model: null, usage: null, outcome: 'generation-error' }] });
  const report = createFailureReport({ id: 'failure', command: 'train', baseline, progressRunId: 'progress', diagnosticId: 'diagnostic', trials, costs });
  const root = join(f.root, 'out');
  const index = await persistResult({ root, store, id: report.id, command: report.command, datasetId: 'development',
    planDigest: 'plan', candidate: baseline, report, trialIds: report.view.trials.map(value => value.id), outcome: 'failed' });
  return { ...f, root, baseline, trials, costs, report, store, index };
}

describe('protected failure report and development-only replay', () => {
  it('retains all observed cost and unknown usage without releasing sealed trial content', async () => {
    const f = await fixture();
    expect(f.index).toMatchObject({ outcome: 'failed', phase: 'train', candidateId: f.baseline.id, trialIds: ['development'] });
    const view = await (await loadInvocationViewer(f.root))();
    expect(view.experiment.status).toBe('failed');
    expect(view.trials.map(value => value.id)).toEqual(['development']);
    expect(view.costs!.observed!.lines).toHaveLength(3);
    expect(view.costs!.observed!.knownSubtotal).toEqual(f.costs.knownSubtotalUsd);
    expect(view.costs!.observed!.total).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/SEALED|PRIVATE|BASE/);
    expect(JSON.stringify(f.report)).not.toMatch(/SEALED|PRIVATE|BASE/);
    await expect(f.store.readBlob(f.index.report, { audience: 'optimizer', phase: 'training' })).rejects.toThrow('Protected');
    await expect(f.store.readReplay('SEALED-trial', { audience: 'operator', phase: 'replay' })).rejects.toThrow('Sealed');
  });

  it('can persist an honest failed snapshot before any trial report exists', async () => {
    const f = await fixture();
    const report = createFailureReport({ id: 'empty', command: 'evaluate', baseline: f.baseline,
      progressRunId: 'progress', diagnosticId: 'diagnostic', trials: [], costs: summarizeCosts([], { subjectModel: 'gpt-5.5' }) });
    const index = { ...f.index, command: 'evaluate' as const, summaryRunId: 'empty', trialIds: [] };
    const view = await loadFailureView(report, index, f.store);
    expect(view.trials).toEqual([]); expect(view.costs!.observed!.total).toBeNull();
  });

  it('rejects tampered phases, outcome, references and report identities', async () => {
    const f = await fixture();
    for (const patch of [{ phase: 'test' }, { outcome: undefined }, { candidateId: 'foreign' },
      { report: { ...f.index.report, runId: 'foreign' } }]) {
      await writeFile(join(f.root, 'invocation.json'), JSON.stringify({ ...f.index, ...patch }));
      await expect((async () => (await loadInvocationViewer(f.root))())()).rejects.toThrow();
    }
    for (const patch of [{ id: 'foreign' }, { command: 'evaluate' }, { candidateId: 'foreign' },
      { schema: 'unknown' }, { status: 'completed' }]) {
      await expect(loadFailureView({ ...f.report, ...patch }, f.index, f.store)).rejects.toThrow();
    }
    const partial = await f.store.putBlob(f.index.summaryRunId, '{"schema":', 'evaluator');
    await writeFile(join(f.root, 'invocation.json'), JSON.stringify({ ...f.index, report: partial }));
    await expect((async () => (await loadInvocationViewer(f.root))())()).rejects.toThrow();
  });

  it('rejects inconsistent view fields and mismatched trial manifests', async () => {
    const f = await fixture();
    const patches = [
      { experiment: { ...f.report.view.experiment, id: 'wrong' } },
      { experiment: { ...f.report.view.experiment, status: 'completed' } },
      { experiment: { ...f.report.view.experiment, phase: 'final-test' } },
      { candidates: [] }, { candidates: [{ ...f.report.view.candidates[0]!, id: 'wrong' }] },
      { usage: [{ purpose: 'subject', model: null, route: null, usage: null }] },
      { cases: [{ id: 'development-case', split: 'test' }] }, { trials: [] },
    ];
    for (const patch of patches) await expect(loadFailureView({ ...f.report, view: { ...f.report.view, ...patch } }, f.index, f.store)).rejects.toThrow();
    await expect(loadFailureView(f.report, { ...f.index, trialIds: ['development', 'development'] }, f.store)).rejects.toThrow();
    for (const patch of [{ caseId: 'wrong' }, { candidateId: 'wrong' }]) {
      const report = { ...f.report, view: { ...f.report.view, trials: [{ ...f.report.view.trials[0]!, ...patch }] } };
      await expect(loadFailureView(report, f.index, f.store)).rejects.toThrow('stored manifest');
    }
    await expect(loadFailureView({ ...f.report, view: { ...f.report.view, cases: [] } }, f.index, f.store)).rejects.toThrow('stored manifest');
  });

  it('cannot grant sealed access by relabeling a case', async () => {
    const f = await fixture();
    const report = { ...f.report, view: { ...f.report.view,
      cases: [{ id: 'SEALED-trial-case', split: 'train' }],
      trials: [{ ...f.report.view.trials[0]!, id: 'SEALED-trial', caseId: 'SEALED-trial-case' }] } };
    await expect(loadFailureView(report, { ...f.index, trialIds: ['SEALED-trial'] }, f.store)).rejects.toThrow('Sealed');
  });
});
