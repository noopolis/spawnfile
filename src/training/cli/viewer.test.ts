import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main, type InvocationIndex } from './index.js';
import { cliFixture, fixtureAdapter } from './fixture.js';
import { loadInvocationViewer, startLiveViewer } from './viewer.js';
import { openExperimentStore } from '../storage/index.js';
import { deriveCandidate, type CandidateManifest } from '../candidates/index.js';
import type { TrialReport } from '../experiments/index.js';
import type { DspyResult } from '../optimization/index.js';

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

  it('publishes only saved presentation snapshots and reveals test identities only after selection freezes', async () => {
    const fixture = await evaluated();
    const urls: string[] = [];
    const live = await startLiveViewer({ port: 0, io: { ...fixture.io, stdout: (text) => { urls.push(JSON.parse(text).viewer); } },
      store: fixture.store, id: 'live', datasetId: 'dataset', planDigest: 'plan', baseline: fixture.candidate,
      cases: [{ id: 'train', split: 'train' }], testCases: [{ id: 'SEALED-CASE', split: 'test' }], budget: { maxMetricCalls: 4, maxProposals: 1 } });
    try {
      const url = urls[0]!;
      const snapshot = async () => (await fetch(`${url}/api/data`)).json();
      const trial = fixture.report.trials[0]!;
      await live.observe({ type: 'trial.finished', payload: { ...trial, phase: 'test', recordId: 'SEALED-CASE' } });
      await live.observe({ type: 'ignored', payload: { secret: 'not public' } });
      expect(JSON.stringify(await snapshot())).not.toContain('SEALED-CASE');
      await live.observe({ type: 'training.started', payload: { train: ['train'], validation: [trial.recordId] } });
      await live.observe({ type: 'trial.finished', payload: { ...trial, phase: 'validation' } });
      await live.observe({ type: 'optimizer.generation.started', payload: { attempt: 1 } });
      await live.observe({ type: 'optimizer.generation.completed', payload: { attempt: 1, model: 'observed', route: 'subscription', usage: null } });
      expect((await snapshot()).optimizer.proposals).toBe(1);
      const optimizer: DspyResult = { schema: 'paideia.dspy.v1', kind: 'result', id: 'live', components: { text: 'PRIVATE' },
        provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 1, proposals: 1, selectedCandidateIndex: 0,
          candidates: [{ components: { text: 'PRIVATE' }, parents: [null], validationScore: 1, discoveryEvaluations: 0 }],
          captures: [{ caseId: trial.recordId, split: 'validation', captureId: trial.id }], generations: [{ model: 'observed', usage: null }] } };
      await live.observe({ type: 'selection.frozen', payload: { optimizer } });
      await live.observe({ type: 'trial.finished', payload: { ...trial, id: 'test-trial', phase: 'test', recordId: 'SEALED-CASE' } });
      await live.observe({ type: 'training.completed', payload: {} });
      const completed = await snapshot();
      expect(completed.cases.some((record: { id: string }) => record.id === 'SEALED-CASE')).toBe(true);
      expect(completed.usage.at(-1)).toMatchObject({ purpose: 'optimizer', model: 'observed', route: 'subscription' });
      expect(JSON.stringify(completed)).not.toMatch(/PRIVATE|Reply OK/);
      vi.spyOn(fixture.store, 'appendEvent').mockRejectedValueOnce(new Error('disk failed'));
      await expect(live.observe({ type: 'training.completed', payload: {} })).resolves.toBeUndefined();
      expect((await fetch(url)).status).toBe(503);
      expect(fixture.stderr.join('')).toContain('native evidence capture continues');
      await live.observe({ type: 'training.completed', payload: {} });
      expect((await fetch(url)).status).toBe(200);
    } finally { await live.close(); }
  });
});
