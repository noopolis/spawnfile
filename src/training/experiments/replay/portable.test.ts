import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { storedJsonDigest } from '../../storage/index.js';
import type { TrialReport } from '../trials/index.js';
import { fixture } from './fixture.js';
import { readTrialEval, regradeTrialEval, writeTrialEval } from './portable.js';

async function capture(change?: (report: TrialReport) => void) {
  const { store, options, runRoot } = await fixture(change);
  const replay = await store.readReplay(options.runId, options.access);
  const record = options.dataset.records[0]!;
  record.outputs = { article: 'article.json' };
  const storeRoot = dirname(dirname(runRoot));
  const name = await writeTrialEval({ storeRoot, record, registry: options.registry }, replay, [], new Map());
  return join(storeRoot, name);
}

it.each(['failed', 'interrupted', 'completed'] as const)('retains %s execution with unconfirmed closure', async execution => {
  const path = await capture(report => { report.execution = execution; });
  expect(await regradeTrialEval(path)).toMatchObject({ execution, status: 'error', evaluation: { status: 'pass' },
    stop: { state: 'acknowledged', quiescence: 'unknown' } });
});

it.each(['deferred', 'limit-exceeded'] as const)('preserves the scored %s delivery outcome', async execution => {
  const path = await capture(report => { report.execution = execution; report.stop!.quiescence = 'confirmed'; });
  expect(await regradeTrialEval(path)).toMatchObject({ execution, status: 'fail', evaluation: { status: 'pass' } });
});

it('keeps missing output coverage unknown and omits unselected collector files', async () => {
  const path = await capture(report => {
    report.stop!.quiescence = 'confirmed';
    report.snapshot.coverage = [];
    report.snapshot.artifacts = { ...report.snapshot.artifacts, cache: { ...report.snapshot.artifacts.article!, name: 'cache', provenance: 'PRIVATE-CACHE' } };
  });
  expect(await readFile(path, 'utf8')).not.toContain('PRIVATE-CACHE');
  expect(await regradeTrialEval(path)).toMatchObject({ coverage: [], status: 'unknown', evaluation: { status: 'unknown' } });
});

it('checks the format version, report identity and grading blob references', async () => {
  const path = await capture();
  const file = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...file, schema: 'unknown' }));
  await expect(readTrialEval(path)).rejects.toThrow();
  file.payload.report.snapshot.trialId = 'other';
  const save = () => writeFile(path, JSON.stringify({ ...file, digest: storedJsonDigest(file.payload) }));
  await save();
  await expect(readTrialEval(path)).rejects.toThrow('identity mismatch');
  file.payload.report.snapshot.trialId = file.payload.report.id;
  file.payload.report.evaluation.checks.old.atomicGrading = { schema: 'spawnfile.training.atomic-grading-blob.v1', blob: {} };
  await save();
  await expect(readTrialEval(path)).rejects.toThrow('blob integrity mismatch');
});
