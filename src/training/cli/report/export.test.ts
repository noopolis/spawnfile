import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openExperimentStore } from '../../storage/index.js';
import { persistResult } from '../output.js';
import { recordedGrade, reportFixture } from './fixture.js';
import { exportTrainingReport, isTrainingReport } from './export.js';
import { renderTrainingMarkdown } from './markdown.js';
import { summarizeTraining } from './summary.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => { const value = await reportFixture(); roots.push(value.root); return value; };

it('exports paid grader receipts and actual semantic gate identities in JSON and Markdown', async () => {
  const { root, report } = await fixture();
  const trial = report.trials[0]!;
  const graded = { id: 'writing', status: 'fail' as const, finality: 'final' as const,
    reason: 'Grader writing; coverage 1', evidence: [], grading: recordedGrade() };
  trial.evaluation.checks.writing = graded;
  trial.evaluation.stages[0]!.checks = [structuredClone(graded)];
  trial.evaluation.stages[0]!.gate = { ...graded, id: undefined, grading: undefined, children: [structuredClone(graded)] };
  const before = structuredClone(report);
  await exportTrainingReport(root, report);
  const summary = JSON.parse(await readFile(join(root, 'REPORT.json'), 'utf8'));
  const markdown = await readFile(join(root, 'REPORT.md'), 'utf8');
  expect(summary.requests.judge).toBe(2);
  expect(summary.costs.knownSubtotalUsd).toEqual({ low: 0.042, high: 0.042 });
  expect(summary.costs.entries.map((entry: { decisionReceipt: unknown }) => entry.decisionReceipt)).toEqual(graded.grading.decisionAccounting!.receipts);
  expect(summary.failingChecks).toContainEqual(expect.objectContaining({ check: 'check/writing/grading/gate/factual-accuracy', status: 'fail' }));
  expect(markdown).toContain('Recorded judge requests: 2');
  expect(markdown).toContain('Known subtotal: 0.042–0.042');
  expect(markdown).toContain('check/writing/grading/gate/factual-accuracy | fail');
  expect(report).toEqual(before);
});

it('persists verified local reports plus every exact candidate and patch, with private permissions', async () => {
  const { root, report } = await fixture();
  const out = join(root, 'out'); const store = await openExperimentStore(out);
  const index = await persistResult({ root: out, store, id: report.id, command: 'train', datasetId: 'test', planDigest: 'plan',
    candidate: report.selected, report, trialIds: report.trials.map(value => value.id) });
  expect(index.phase).toBe('test'); expect(index.trainingExport).toBeDefined();
  const summary = JSON.parse(await readFile(join(out, 'REPORT.json'), 'utf8'));
  const markdown = await readFile(join(out, 'REPORT.md'), 'utf8');
  expect(markdown).toContain('Selected candidate: **candidate-1**');
  for (const heading of ['Split scores', 'Rounds', 'Per-example scores', 'Failing checks', 'Held-out comparison and uncertainty',
    'Durations, requests and costs', 'Fidelity', 'Candidate diffs against baseline']) expect(markdown).toContain(`## ${heading}`);
  expect(summary.candidates).toHaveLength(3);
  for (const entry of summary.candidates) {
    for (const resource of entry.candidate.resources) {
      const file = join(out, index.trainingExport!.directory, 'candidates', entry.label, 'files', resource.sourcePath);
      expect(await readFile(file, 'utf8')).toBe(resource.content);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    const patch = await readFile(join(out, index.trainingExport!.directory, 'candidates', entry.label, 'baseline.diff'), 'utf8');
    if (entry.label !== 'baseline') expect(patch).toContain('@@'); else expect(patch).toBe('');
  }
  expect((await stat(join(out, index.trainingExport!.directory))).mode & 0o777).toBe(0o700);
  expect((await stat(join(out, 'REPORT.md'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(out, index.trainingExport!.json), 'utf8')).toBe(await readFile(join(out, 'REPORT.json'), 'utf8'));
  expect(await readFile(join(out, index.trainingExport!.markdown), 'utf8')).toContain('(./candidates/');
  await expect(store.readBlob(index.report, { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
});

it.each(['failed', 'evaluate', 'legacy'] as const)('does not release training artifacts for %s reports', async mode => {
  const { root, report } = await fixture(); const out = join(root, 'out'); const store = await openExperimentStore(out);
  const index = await persistResult({ root: out, store, id: mode, command: mode === 'evaluate' ? 'evaluate' : 'train',
    ...(mode === 'failed' ? { outcome: 'failed' as const } : {}), datasetId: 'test', planDigest: 'plan', candidate: report.selected,
    report: mode === 'legacy' ? {} : report, trialIds: [] });
  expect(index.trainingExport).toBeUndefined();
  await expect(stat(join(out, 'REPORT.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves immutable exports on resume and replaces convenience symlinks without following them', async () => {
  const { root, report } = await fixture();
  const first = await exportTrainingReport(root, report);
  const original = await readFile(join(root, first.markdown), 'utf8');
  const sentinel = join(root, 'sentinel'); await writeFile(sentinel, 'do not overwrite');
  await rm(join(root, 'REPORT.md')); await symlink(sentinel, join(root, 'REPORT.md'));
  const second = await exportTrainingReport(root, { ...report, id: 'resumed' });
  expect(second.directory).not.toBe(first.directory);
  expect(await readFile(join(root, first.markdown), 'utf8')).toBe(original);
  expect(await readFile(sentinel, 'utf8')).toBe('do not overwrite');
  expect(await readFile(join(root, 'REPORT.md'), 'utf8')).toContain('resumed');
});

it('fails on readback mismatch and removes partial exports before indexing success', async () => {
  const { root, report } = await fixture();
  vi.mocked(readFile).mockResolvedValueOnce('tampered');
  await expect(exportTrainingReport(root, report)).rejects.toThrow('did not persist faithfully');
  expect((await readdir(root)).filter(value => value.startsWith('.training-report-'))).toEqual([]);
  await expect(stat(join(root, 'REPORT.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('surfaces a report publication error and never publishes a completion index', async () => {
  const { root, report } = await fixture(); const out = join(root, 'out'); const store = await openExperimentStore(out);
  await mkdir(join(out, 'REPORT.md'));
  await expect(persistResult({ root: out, store, id: 'blocked', command: 'train', datasetId: 'test', planDigest: 'plan',
    candidate: report.selected, report, trialIds: [] })).rejects.toThrow();
  await expect(stat(join(out, 'invocation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(out)).filter(value => value.startsWith('.REPORT'))).toEqual([]);
});

it('renders missing costs/rounds, escaped failure prose and arbitrary diff fences honestly', async () => {
  const { report } = await fixture();
  delete report.costs; delete report.optimizer.provenance.rounds; delete report.durationMs;
  const value = report.trials[0]!; value.status = 'fail';
  value.evaluation.checks['x|<script>`'] = { status: 'unknown', finality: 'final', reason: 'a\nb|<script>`', evidence: [] };
  const markdown = renderTrainingMarkdown(summarizeTraining(report), '.', { 'candidate-1': '```\n+new\n' });
  expect(markdown).toContain('No cost receipts'); expect(markdown).toContain('&#124;&lt;script&gt;&#96;');
  expect(markdown).toContain('````diff'); expect(markdown).toContain('unknown / not run');
  expect(markdown).toContain('trial-outcome');
});

it('recognizes only the declared completed training envelope', async () => {
  const { report } = await fixture();
  expect(isTrainingReport(report)).toBe(true);
  for (const value of [null, 2, {}, { schema: 'paideia.failure.v1' }]) expect(isTrainingReport(value)).toBe(false);
});

it('rejects an export bound to a different frozen summary candidate', async () => {
  const { root, report } = await fixture(); const store = await openExperimentStore(root);
  await expect(persistResult({ root, store, id: 'wrong', command: 'train', datasetId: 'test', planDigest: 'plan',
    candidate: report.baseline, report, trialIds: [] })).rejects.toThrow('frozen summary candidate');
  await expect(stat(join(root, 'REPORT.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('renders complete API-equivalent ranges, unpriced groups and absent legacy isolation separately', async () => {
  const { report } = await fixture();
  const costs = report.costs!;
  costs.apiEquivalentUsd = { low: 0.01, high: 0.02 }; costs.knownSubtotalUsd = { low: 0.01, high: 0.02 };
  costs.groups = [{ role: 'judge', name: 'judge-route', entryCount: 1, models: ['model'],
    apiEquivalentUsd: { low: 0.01, high: 0.02 }, knownSubtotalUsd: { low: 0.01, high: 0.02 }, completeness: 'complete' },
  { role: 'optimizer', name: 'unknown-route', entryCount: 1, models: [null], apiEquivalentUsd: null,
    knownSubtotalUsd: { low: 0, high: 0 }, completeness: 'incomplete' }];
  delete report.trials[0]!.subject;
  const markdown = renderTrainingMarkdown(summarizeTraining(report), '.', {});
  expect(markdown).toContain('0.01–0.02'); expect(markdown).toContain('judge-route');
  expect(markdown).toContain('unknown-route'); expect(markdown).toContain('isolation unknown');
  expect(markdown).toContain('No non-passing checks recorded.');
});
