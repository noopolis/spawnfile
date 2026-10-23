import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { blobContentPath, hydrateEvaluationJson, openExperimentStore, type BlobReference } from '../../storage/index.js';
import type { TrainingReport, TrialReport } from '../../experiments/index.js';
import { persistResult } from '../output.js';
import { loadInvocationViewer } from '../viewer.js';
import { exportTrainingReport } from './export.js';
import { reportFixture } from './fixture.js';
import type { TrainingSummary } from './summary.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function maskedAtomicError(trial: TrialReport) {
  const digest = 'a'.repeat(64);
  // The outer verdict masks the failed measurement. No atomicFailure shortcut:
  // only hydrated atomicGrading can distinguish this from a behavioral zero.
  const check = { id: 'writing', status: 'fail' as const, finality: 'final' as const,
    reason: 'Logical failure masks an errored measurement', evidence: [],
    atomicGrading: { schema: 'paideia.atomic-grade.v1' as const, status: 'error' as const, score: null,
      coverage: 0, criticalGate: 1, obligationCoverage: 1, quality: 0,
      identity: { definitionDigest: digest, templatesDigest: digest, outputDigest: digest, contextDigest: digest },
      checks: [], extraction: { receipts: [{ error: 'request rejected' }], judgeCalls: [] },
      receipts: [{ requestId: `atomic-${trial.id}`, billing: 'api' as const, model: 'atomic-fixture',
        endpoint: 'https://example.test', inputTokens: 500, outputTokens: 0, usd: 0.021,
        estimatedInputTokens: 1000, estimatedUsd: 0.2, latencyMs: 5, status: 402 }],
      judgeCalls: [], feedback: { failed_check_count: 0, omitted_failed_checks: 0, failed_checks: [] } } };
  trial.status = 'fail';
  trial.evaluation.status = 'fail';
  trial.evaluation.checks.writing = check;
  trial.evaluation.stages[0]!.checks = [structuredClone(check)];
  return check.atomicGrading.receipts;
}

function assertUnscorable(summary: TrainingSummary, trial: TrialReport) {
  const split = summary.candidates.find(entry => entry.candidate.id === trial.candidateId)!.splits[trial.phase];
  const example = split.examples.find(entry => entry.id === trial.recordId)!;
  expect(example.measurements.find(entry => entry.trialId === trial.id)).toMatchObject({
    score: null, scoreUnavailable: expect.stringContaining('unscorable atomic grading measurement') });
  expect(example.meanScore).toBeNull();
  expect(split.complete).toBe(false);
  expect(split.meanScore).toBeNull();
}

async function persistedFixture() {
  const { root, report } = await reportFixture(); roots.push(root);
  const trial = report.trials[0]!;
  const receipts = maskedAtomicError(trial);
  report.optimizer.provenance.captures = report.optimizer.provenance.candidates.map(() => ({
    split: 'validation', caseId: 'validation-example', captureId: report.trials[1]!.id, score: 0 }));
  const out = join(root, 'out');
  const store = await openExperimentStore(out);
  const index = await persistResult({ root: out, store, id: report.id, command: 'train', datasetId: 'test', planDigest: 'plan',
    candidate: report.selected, report, trialIds: report.trials.map(value => value.id) });
  const access = { audience: 'operator' as const, phase: 'test' as const, frozenCandidateIds: [report.selected.id] };
  const compact = JSON.parse((await store.readBlob(index.report, access)).toString());
  expect(compact.trials[0].evaluation.checks.writing.atomicGrading.schema).toBe('paideia.atomic-grading-blob.v1');
  const exportStored = async (target: string) => exportTrainingReport(target,
    await hydrateEvaluationJson<TrainingReport>(store, compact, access));
  return { root, out, store, access, compact, report, trial, receipts, exportStored };
}

it('keeps masked atomic errors unscorable through real viewer replay and persisted export', async () => {
  const { out, trial } = await persistedFixture();
  const viewer = await loadInvocationViewer(out);
  expect((await viewer()).trials.find(value => value.id === trial.id)?.score).toBeNull();
  const summary = JSON.parse(await readFile(join(out, 'REPORT.json'), 'utf8')) as TrainingSummary;
  assertUnscorable(summary, trial);
  expect(await readFile(join(out, 'REPORT.md'), 'utf8')).toContain('unknown / not run | fail');
});

it('retains nonempty atomic receipts through persisted and hydrated stored exports', async () => {
  const { out, root, exportStored, trial, receipts } = await persistedFixture();
  const exported = await exportStored(root);
  for (const path of [join(out, 'REPORT.json'), join(root, exported.json)]) {
    const summary = JSON.parse(await readFile(path, 'utf8')) as TrainingSummary;
    expect(summary.requests.judge).toBe(1); // Aggregate/stage aliases must not double count.
    expect(summary.costs!.entries.filter(entry => entry.decisionReceipt).map(entry => entry.decisionReceipt)).toEqual(receipts);
    expect(summary.costs!.knownSubtotalUsd).toEqual({ low: 0.021, high: 0.021 });
    assertUnscorable(summary, trial);
  }
  for (const path of [join(out, 'REPORT.md'), join(root, exported.markdown)]) {
    const markdown = await readFile(path, 'utf8');
    expect(markdown).toContain('Recorded judge requests: 1');
    expect(markdown).toContain('Known subtotal: 0.021–0.021');
  }
});

it.each(['missing', 'same-length corrupt'] as const)('fails viewer replay and stored export closed for a %s atomic blob', async mode => {
  const { out, root, store, access, compact, exportStored } = await persistedFixture();
  const viewer = await loadInvocationViewer(out);
  await viewer(); // The same loader must notice damage on a subsequent replay.
  const reference = compact.trials[0].evaluation.checks.writing.atomicGrading.blob as BlobReference;
  const path = blobContentPath(out, reference);
  if (mode === 'missing') await rm(path);
  else {
    const original = await readFile(path, 'utf8');
    const changed = original.replace('"status":402', '"status":200');
    expect(changed).not.toBe(original);
    expect(Buffer.byteLength(changed)).toBe(reference.size);
    expect(JSON.parse(changed).receipts[0].status).toBe(200);
    await writeFile(path, changed);
  }
  // The enclosing report remains authentic: the error belongs to its detail blob.
  await expect(store.readBlob((JSON.parse(await readFile(join(out, 'invocation.json'), 'utf8'))).report, access)).resolves.toBeInstanceOf(Buffer);
  const error = mode === 'missing' ? /ENOENT/ : /Stored blob content is corrupt/;
  await expect(viewer()).rejects.toThrow(error);
  await expect(exportStored(root)).rejects.toThrow(error);
  await expect(stat(join(root, 'REPORT.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(root, 'REPORT.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('exports identical scores/evidence from large referenced reports and preserves viewer replay', async () => {
  const { root, report } = await reportFixture(); roots.push(root);
  const original = report.trials[0]!;
  const digest = 'a'.repeat(64);
  report.trials = Array.from({ length: 38 }, (_, index) => {
    const trial = { ...structuredClone(original), id: `large-trial-${index}` };
    const check = { id: 'writing', status: 'fail' as const, finality: 'final' as const, score: 0.25,
      reason: `Evidence for trial ${index}`, evidence: [{ kind: 'output' as const, id: 'article' }],
      atomicGrading: { schema: 'paideia.atomic-grade.v1' as const, status: 'fail' as const, score: 0.25,
        coverage: 1, criticalGate: 1, obligationCoverage: 1, quality: 0.25,
        identity: { definitionDigest: digest, templatesDigest: digest, outputDigest: digest, contextDigest: digest },
        checks: [], extraction: { receipts: [{ trial: index, response: 'x'.repeat(1024 * 1024) }], judgeCalls: [] },
        receipts: [{ requestId: `large-atomic-${index}`, billing: 'api' as const, model: 'atomic-fixture',
          endpoint: 'https://example.test', inputTokens: 500, outputTokens: 0, usd: 0.021,
          estimatedInputTokens: 1000, estimatedUsd: 0.2, latencyMs: 5, status: 200 }],
        judgeCalls: [], feedback: { failed_check_count: 0, omitted_failed_checks: 0, failed_checks: [] } } };
    trial.evaluation.checks.writing = check;
    trial.evaluation.stages[0]!.checks = [structuredClone(check)];
    return trial;
  });
  report.optimizer.provenance.captures = report.optimizer.provenance.candidates.map(() => ({
    split: 'validation', caseId: 'validation-example', captureId: report.trials[0]!.id, score: 0.25 }));
  const inline = JSON.parse(JSON.stringify(report));
  expect(Buffer.byteLength(JSON.stringify(inline))).toBeGreaterThan(67_108_864);
  const out = join(root, 'out');
  const store = await openExperimentStore(out);
  const index = await persistResult({ root: out, store, id: report.id, command: 'train', datasetId: 'test', planDigest: 'plan',
    candidate: report.selected, report, trialIds: report.trials.map(trial => trial.id) });
  const access = { audience: 'operator' as const, phase: 'test' as const, frozenCandidateIds: [report.selected.id] };
  const bytes = await store.readBlob(index.report, access);
  expect(bytes.length).toBeLessThan(256 * 1024);
  const hydrated = await hydrateEvaluationJson(store, JSON.parse(bytes.toString()), access);
  expect(hydrated).toEqual(inline);
  expect(report).toEqual(inline);
  await expect(hydrateEvaluationJson(store, JSON.parse(bytes.toString()), { audience: 'optimizer', phase: 'training' })).rejects.toThrow('Optimizer');
  const inlineOut = await mkdtemp(join(tmpdir(), 'inline-report-')); roots.push(inlineOut);
  const exported = await exportTrainingReport(inlineOut, hydrated as TrainingReport);
  const expectedJson = JSON.parse(await readFile(join(inlineOut, 'REPORT.json'), 'utf8'));
  const actualJson = JSON.parse(await readFile(join(out, 'REPORT.json'), 'utf8'));
  delete expectedJson.bundle; delete actualJson.bundle;
  expect(actualJson.requests.judge).toBe(38);
  expect(actualJson.costs.entries.filter((entry: { decisionReceipt?: unknown }) => entry.decisionReceipt)).toHaveLength(38);
  expect(actualJson).toEqual(expectedJson);
  expect(await readFile(join(out, index.trainingExport!.directory, 'REPORT.md'), 'utf8'))
    .toBe(await readFile(join(inlineOut, exported.directory, 'REPORT.md'), 'utf8'));
  expect((await stat(join(out, 'REPORT.md'))).size).toBeGreaterThan(0);
  const viewer = await loadInvocationViewer(out);
  expect((await viewer()).trials).toHaveLength(38);
}, 60000);
