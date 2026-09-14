import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main, type InvocationIndex } from './index.js';
import { cliFixture, fixtureAdapter } from './fixture.js';
import { loadInvocationViewer, startLiveViewer } from './viewer.js';
import { openExperimentStore } from '../storage/index.js';
import { deriveCandidate, type CandidateManifest } from '../candidates/index.js';
import type { RescoreReport } from '../experiments/replay/index.js';
import type { TrialReport } from '../experiments/index.js';
import type { DspyResult } from '../optimization/index.js';
import { summarizeCosts } from '../experiments/costs/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function evaluated() {
  const fixture = await cliFixture(); roots.push(fixture.root);
  fixture.dependencies.adapter = (id) => fixtureAdapter(id, fixture.observedInstructions, 'pass');
  expect(await main(['evaluate', 'data.yaml', ...fixture.nativeArgs, '--view', '0'], fixture.io, fixture.dependencies)).toBe(0);
  const out = join(fixture.root, 'out');
  const index = JSON.parse(await readFile(join(out, 'invocation.json'), 'utf8')) as InvocationIndex;
  const store = await openExperimentStore(out);
  const access = { audience: 'operator' as const, phase: 'replay' as const };
  const candidate = JSON.parse((await store.readBlob(index.candidate, access)).toString()) as CandidateManifest;
  const report = JSON.parse((await store.readBlob(index.report, access)).toString()) as { schema: string; candidateId: string; trials: TrialReport[] };
  return { ...fixture, out, index, store, candidate, report };
}

describe('usable persisted viewer command', () => {
  it('serves actual stored reports, then closes on Ctrl+C without invoking any subject again', async () => {
    const fixture = await evaluated();
    const snapshot = await (await loadInvocationViewer(fixture.out))();
    expect(snapshot.trials).toHaveLength(1); expect(snapshot.trials[0]!.score).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('Reply OK.');
    const controller = new AbortController();
    let ready!: (url: string) => void;
    const address = new Promise<string>((resolve) => { ready = resolve; });
    const running = main(['view', fixture.out, '--port', '0'], { ...fixture.io, signal: controller.signal,
      stdout: (text) => { const result = JSON.parse(text); ready(result.viewer); } });
    const url = await address;
    const response = await fetch(`${url}/api/data`);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(snapshot);
    controller.abort(); expect(await running).toBe(130);
    await expect(fetch(url)).rejects.toThrow();
    expect(fixture.observedInstructions).toHaveLength(1);
    const missing = join(fixture.root, 'absent');
    expect(await main(['view', missing], fixture.io)).toBe(2);
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects mismatched index, manifest, candidate and report identities', async () => {
    const fixture = await evaluated();
    const path = join(fixture.out, 'invocation.json');
    for (const patch of [{ phase: 'test' }, { report: { ...fixture.index.report, runId: 'wrong' } }, { candidateId: 'wrong' }]) {
      await writeFile(path, JSON.stringify({ ...fixture.index, ...patch }));
      await expect((async () => (await loadInvocationViewer(fixture.out))())()).rejects.toThrow(/inconsistent|does not match/);
    }
    const wrongCandidate = deriveCandidate(fixture.candidate, fixture.candidate, {});
    const candidateRef = await fixture.store.putBlob(fixture.index.summaryRunId, JSON.stringify(wrongCandidate), 'evaluator');
    await writeFile(path, JSON.stringify({ ...fixture.index, candidate: candidateRef }));
    await expect((async () => (await loadInvocationViewer(fixture.out))())()).rejects.toThrow('candidate does not match');
    const reportRef = await fixture.store.putBlob(fixture.index.summaryRunId, JSON.stringify({ ...fixture.report, candidateId: 'wrong' }), 'evaluator');
    await writeFile(path, JSON.stringify({ ...fixture.index, report: reportRef }));
    await expect((async () => (await loadInvocationViewer(fixture.out))())()).rejects.toThrow('evaluation report does not match');
  });

  it('replays saved cost valuations without repricing or exposing private accounting evidence', async () => {
    const fixture = await evaluated();
    const costs = summarizeCosts(fixture.report.trials, { subjectModel: 'gpt-5.5' });
    costs.apiEquivalentUsd = { low: 12.34, high: 56.78 };
    costs.warnings.push('SECRET judge text');
    costs.entries[0]!.id = 'SECRET call';
    const report = await fixture.store.putBlob(fixture.index.summaryRunId,
      JSON.stringify({ ...fixture.report, costs }), 'evaluator');
    await writeFile(join(fixture.out, 'invocation.json'), JSON.stringify({ ...fixture.index, report }));
    const snapshot = await (await loadInvocationViewer(fixture.out))();
    expect(snapshot.costs!.observed!.total).toEqual({ low: 12.34, high: 56.78 });
    expect(snapshot.costs!.observed!.lines[0]).toMatchObject({ model: 'gpt-5.5', modelBasis: 'requested-assumption' });
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
    expect(fixture.observedInstructions).toHaveLength(1);
  });

  it('publishes only saved presentation snapshots and reveals test identities only after selection freezes', async () => {
    const fixture = await evaluated();
    const urls: string[] = [];
    const live = await startLiveViewer({ port: 0, io: { ...fixture.io, stdout: (text) => { urls.push(JSON.parse(text).viewer); } },
      store: fixture.store, id: 'live', datasetId: 'dataset', planDigest: 'plan', baseline: fixture.candidate,
      cases: [{ id: 'train', split: 'train' }], testCases: [{ id: 'SEALED-CASE', split: 'test' }], budget: { maxMetricCalls: 4, maxProposals: 1 },
      costs: { subjectModel: 'gpt-5.5' } });
    try {
      const url = urls[0]!;
      const snapshot = async () => (await fetch(`${url}/api/data`)).json();
      const trial = fixture.report.trials[0]!;
      const sealed = { ...trial, id: 'sealed-restored', phase: 'test', recordId: 'SEALED-CASE', evaluation: { ...trial.evaluation,
        judgeCalls: [{ id: 'SEALED-CALL', judge: 'SEALED-JUDGE', providerId: 'subscription', requestedModel: 'SEALED-MODEL',
          responseModel: 'SEALED-MODEL', responseRoute: 'subscription', outcome: 'completed', usage: null }] } };
      await live.observe({ type: 'trial.finished', payload: sealed });
      await live.observe({ type: 'trial.progress', payload: { trialId: sealed.id, caseId: 'SEALED-CASE', phase: 'test',
        event: { type: 'observation', payload: { type: 'tool.dispatch', arguments: 'SECRET' } } } });
      await live.observe({ type: 'ignored', payload: { secret: 'not public' } });
      expect(JSON.stringify(await snapshot())).not.toContain('SEALED');
      await live.observe({ type: 'training.started', payload: { train: ['train'], validation: [trial.recordId] } });
      await live.observe({ type: 'trial.finished', payload: { ...trial, phase: 'validation' } });
      await live.observe({ type: 'optimizer.generation.started', payload: { attempt: 1 } });
      expect((await snapshot()).costs.observed.lines.at(-1)).toMatchObject({ outcome: 'pending', amount: null });
      await live.observe({ type: 'optimizer.generation.completed', payload: { attempt: 1, model: 'observed', modelBasis: 'requested-assumption', route: 'subscription', usage: null } });
      await live.observe({ type: 'optimizer.generation.completed', payload: { attempt: 1, model: 'observed', modelBasis: 'requested-assumption', route: 'subscription', usage: null } });
      await live.observe({ type: 'optimizer.generation.failed', payload: { attempt: 2 } });
      const progress = await snapshot();
      expect(progress.optimizer.proposals).toBe(2);
      await live.observe({ type: 'trial.progress', payload: { trialId: trial.id, caseId: trial.recordId, phase: 'validation',
        event: { type: 'observation', payload: { type: 'tool.dispatch', arguments: 'SECRET' } } } });
      expect((await snapshot()).activity).toMatchObject({ trialId: trial.id, toolCalls: 1 });
      expect(progress.costs.observed.lines).toHaveLength(5);
      expect(progress.costs.observed.lines[3]).toMatchObject({ model: null, requestedModel: 'observed', modelBasis: 'unknown' });
      expect(progress.costs.observed.lines.at(-1)).toMatchObject({ role: 'optimizer', model: null, outcome: 'generation-error', amount: null });
      expect(progress.costs.observed.total).toBeNull();
      const optimizer: DspyResult = { schema: 'paideia.dspy.v1', kind: 'result', id: 'live', components: { text: 'PRIVATE' },
        provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 1, proposals: 1, selectedCandidateIndex: 0,
          candidates: [{ components: { text: 'PRIVATE' }, parents: [null], validationScore: 1, discoveryEvaluations: 0 }],
          captures: [{ caseId: trial.recordId, split: 'validation', captureId: trial.id }], generations: [{ model: 'observed', usage: null }] } };
      await live.observe({ type: 'selection.frozen', payload: { optimizer } });
      await live.observe({ type: 'trial.progress', payload: { trialId: 'test-progress', caseId: 'SEALED-CASE', phase: 'test',
        event: { type: 'trial.started', payload: {} } } });
      await live.observe({ type: 'trial.finished', payload: { ...trial, id: 'test-trial', phase: 'test', recordId: 'SEALED-CASE' } });
      await live.observe({ type: 'training.completed', payload: {} });
      const completed = await snapshot();
      expect(completed.cases.some((record: { id: string }) => record.id === 'SEALED-CASE')).toBe(true);
      expect(completed.usage.find((entry: { purpose: string }) => entry.purpose === 'optimizer'))
        .toMatchObject({ purpose: 'optimizer', model: 'observed', modelBasis: 'requested-assumption', route: 'subscription' });
      expect(JSON.stringify(completed)).not.toMatch(/PRIVATE|Reply OK/);
      vi.spyOn(fixture.store, 'appendEvent').mockRejectedValueOnce(new Error('disk failed'));
      await expect(live.observe({ type: 'training.completed', payload: {} })).resolves.toBeUndefined();
      expect((await fetch(url)).status).toBe(503);
      expect(fixture.stderr.join('')).toContain('native evidence capture continues');
      await live.observe({ type: 'training.completed', payload: {} });
      expect((await fetch(url)).status).toBe(200);
      await live.observe({ type: 'optimizer.generation.started', payload: { attempt: 3 } });
      await live.observe({ type: 'experiment.failed', payload: { error: 'PRIVATE provider diagnostic' } });
      const failed = await snapshot();
      expect(failed.experiment).toMatchObject({ status: 'failed', phase: 'train' });
      expect(failed.optimizer.status).toBe('failed');
      expect(failed.costs.observed.lines.at(-1)).toMatchObject({ outcome: 'interrupted; usage unknown', amount: null });
      expect(failed.costs.observed.groups.find((group: { role: string }) => group.role === 'subject').entryCount).toBe(3);
      expect(failed.trials).toHaveLength(1);
      expect(failed.usage).toEqual([]);
      expect(JSON.stringify(failed)).not.toMatch(/PRIVATE|SEALED|test-trial|Reply OK/);
      for (const event of [
        { type: 'trial.finished', payload: trial },
        { type: 'optimizer.generation.started', payload: { attempt: 4 } },
        { type: 'selection.frozen', payload: { optimizer } },
        { type: 'training.completed', payload: {} },
      ]) {
        await live.observe(event);
        expect(await snapshot()).toEqual(failed);
      }
    } finally { await live.close(); }
  });
});

it.each([false, true])('retains restored sealed spending through failure (selection frozen: %s)', async frozen => {
  const f = await evaluated(), urls: string[] = [], native = f.report.trials[0]!;
  const sealed: TrialReport = { ...native, id: 'SEALED-trial', recordId: 'SEALED-case', phase: 'test' };
  const call = { id: 'SEALED-call', judge: 'SEALED-judge', providerId: 'SEALED-provider', requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.5', responseRoute: 'SEALED-route', outcome: 'completed' as const,
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: null, source: 'SECRET' } };
  const rescore: RescoreReport = { schema: 'paideia.rescore.v1', id: 'SEALED-rescore', runId: sealed.id, scope: 'final-stages',
    notReevaluated: ['live', 'per-turn'], original: { evaluationId: 'old', digest: 'old', candidateId: sealed.candidateId,
      datasetDigest: 'old', planDigest: 'old', recordId: sealed.recordId, phase: sealed.phase, status: sealed.status },
    criteria: { datasetId: 'dataset', datasetDigest: 'digest', sharedPlanDigest: 'plan', stages: [], registryVersions: {},
      sidecarDigests: {}, inferenceRoutes: { judges: {}, embeddings: {} } },
    execution: sealed.execution, hostWork: sealed.hostWork, coverage: [], status: 'pass',
    evaluation: { ...sealed.evaluation, judgeCalls: [call] } };
  const live = await startLiveViewer({ port: 0, io: { ...f.io, stdout: text => { urls.push(JSON.parse(text).viewer); } },
    store: f.store, id: 'restore-failure', datasetId: 'dataset', planDigest: 'plan', baseline: f.candidate,
    cases: [], testCases: [{ id: sealed.recordId, split: 'test' }], budget: { maxMetricCalls: 4, maxProposals: 1 },
    costs: { subjectModel: 'gpt-5.5' } });
  try {
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      await live.observe({ type: 'trial.restored', payload: sealed });
      await live.observe({ type: 'trial.rescore.restored', payload: rescore });
    }
    const expected = summarizeCosts([sealed], { subjectModel: 'gpt-5.5', rescores: [rescore] });
    let before = await (await fetch(`${urls[0]}/api/data`)).json();
    expect(before.trials).toEqual([]); expect(before.cases).toEqual([]);
    expect(before.costs.observed.knownSubtotal).toEqual(expected.knownSubtotalUsd);
    expect(before.costs.observed.lines).toHaveLength(2);
    expect(before.costs.observed.lines[1]).toMatchObject({ name: 'judge', model: null, provider: null, route: null });
    expect(JSON.stringify(before)).not.toMatch(/SEALED|SECRET/);
    if (frozen) {
      await live.observe({ type: 'training.started', payload: { train: [], validation: [native.recordId] } });
      await live.observe({ type: 'trial.restored', payload: { ...native, phase: 'validation' } });
      const optimizer: DspyResult = { schema: 'paideia.dspy.v1', kind: 'result', id: 'restored', components: {},
        provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
          evaluations: 1, proposals: 0, selectedCandidateIndex: 0, generations: [],
          candidates: [{ components: {}, parents: [null], validationScore: 1, discoveryEvaluations: 0 }],
          captures: [{ caseId: native.recordId, split: 'validation', captureId: native.id }] } };
      await live.observe({ type: 'selection.frozen', payload: { optimizer } });
      await live.observe({ type: 'trial.rescored', payload: rescore });
      await live.observe({ type: 'trial.rescored', payload: { ...rescore, id: 'development-rescore', runId: native.id,
        original: { ...rescore.original, phase: 'validation' }, evaluation: native.evaluation } });
      before = await (await fetch(`${urls[0]}/api/data`)).json();
      expect(before.trials).toHaveLength(2);
      expect(before.trials.find((row: { id: string }) => row.id === sealed.id).status).toContain('rescored');
      expect(before.costs.observed.lines).toHaveLength(3);
    }
    await live.observe({ type: 'experiment.failed', payload: {} });
    const failed = await (await fetch(`${urls[0]}/api/data`)).json();
    expect(failed.experiment.status).toBe('failed');
    expect(failed.costs.observed.knownSubtotal).toEqual(before.costs.observed.knownSubtotal);
    expect(failed.costs.observed.lines).toHaveLength(before.costs.observed.lines.length);
    expect(failed.trials).toHaveLength(frozen ? 1 : 0);
    expect(JSON.stringify(failed)).not.toMatch(/SEALED|SECRET/);
    expect(f.observedInstructions).toHaveLength(1);
  } finally { await live.close(); }
});

it.each(['experiment.failed', 'training.completed'])('sends saved %s state to an already connected browser during close', async type => {
  const f = await evaluated(), urls: string[] = [];
  const live = await startLiveViewer({ port: 0, io: { ...f.io, stdout: text => { urls.push(JSON.parse(text).viewer); } },
    store: f.store, id: 'terminal', datasetId: 'dataset', planDigest: 'plan', baseline: f.candidate,
    cases: [{ id: f.report.trials[0]!.recordId, split: 'train' }], testCases: [], costs: { subjectModel: 'gpt-5.5' } });
  try {
    const response = await fetch(`${urls[0]}/api/events`), reader = response.body!.getReader();
    await reader.read();
    await live.observe({ type: 'trial.finished', payload: f.report.trials[0] });
    await live.observe({ type, payload: {} });
    const final = (async () => { let text = ''; while (true) {
      const chunk = await reader.read(); if (chunk.done) return text; text += new TextDecoder().decode(chunk.value);
    } })();
    await live.close();
    const frame = /event: final\ndata: (.+)\n\n/.exec(await final);
    expect(frame).not.toBeNull(); const { html } = JSON.parse(frame![1]!);
    expect(html).toContain(type === 'experiment.failed' ? 'Run stopped' : '>completed<');
    expect(html).toContain('1 trials'); expect(html).toContain('Costs & usage');
    expect(html).toContain('gpt-5.5'); expect(html).not.toContain('Reply OK.');
    const replay = await f.store.readReplay('viewer-terminal', { audience: 'viewer', phase: 'training' });
    expect((replay.events.at(-1)!.payload as { experiment: { status: string } }).experiment.status)
      .toBe(type === 'experiment.failed' ? 'failed' : 'completed');
  } finally { await live.close(); }
});

it('never sends an unpersisted final snapshot when its storage append fails', async () => {
  const f = await evaluated(), urls: string[] = [];
  const live = await startLiveViewer({ port: 0, io: { ...f.io, stdout: text => { urls.push(JSON.parse(text).viewer); } },
    store: f.store, id: 'terminal-persistence', datasetId: 'dataset', planDigest: 'plan', baseline: f.candidate, cases: [], testCases: [] });
  try {
    const response = await fetch(`${urls[0]}/api/events`), reader = response.body!.getReader(); await reader.read();
    vi.spyOn(f.store, 'appendEvent').mockRejectedValueOnce(new Error('PRIVATE disk failure'));
    await live.observe({ type: 'experiment.failed', payload: {} });
    const final = (async () => { let text = ''; while (true) {
      const chunk = await reader.read(); if (chunk.done) return text; text += new TextDecoder().decode(chunk.value);
    } })();
    await live.close();
    const frame = /event: final\ndata: (.+)\n\n/.exec(await final);
    expect(frame).not.toBeNull(); const { html } = JSON.parse(frame![1]!);
    expect(html).toContain('>starting<'); expect(html).not.toMatch(/Run stopped|PRIVATE disk/);
  } finally { await live.close(); }
});
