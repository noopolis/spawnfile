import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { storedJsonDigest } from '../../storage/index.js';
import type { TrialReport } from '../trials/index.js';
import { fixture } from './fixture.js';
import { readTrialEval, regradeTrialEval, writeTrialEval } from './portable.js';

async function capture(change?: (report: TrialReport) => void, prepared?: Record<string, { collector: string }>) {
  const { store, options, runRoot } = await fixture(change);
  const replay = await store.readReplay(options.runId, options.access);
  const record = options.dataset.records[0]!;
  record.outputs = { article: 'article.json' };
  if (prepared) record.setup = { profile: 'fixture', artifacts: prepared };
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

it.each([
  ['trial-reply', ['article', 'reply']],
  ['operator-file', ['article']],
] as const)('includes only the authoritative implicit reply beside declared files (%s)', async (provenance, names) => {
  const path = await capture(report => {
    report.snapshot.artifacts = { ...report.snapshot.artifacts,
      reply: { ...report.snapshot.artifacts.article!, name: 'reply', provenance } };
  });
  expect(Object.keys((await readTrialEval(path)).report.snapshot.artifacts).sort()).toEqual(names);
});

it('keeps the measured trial identity on reuse and excludes opaque native data', async () => {
  const path = await capture(report => {
    report.turns[0]!.native.evidence = { adapterId: 'native', reusedFrom: 'measured-trial', payload: 'private native bytes' };
  });
  expect((await readTrialEval(path)).report.turns[0]!.native.evidence)
    .toEqual({ adapterId: 'native', reusedFrom: 'measured-trial', payload: null });
  expect(await readFile(path, 'utf8')).not.toContain('private native bytes');
});

it('includes declared preparation artifacts without copying their collector configuration', async () => {
  const path = await capture(report => {
    report.snapshot.artifacts = { ...report.snapshot.artifacts, brief: { ...report.snapshot.artifacts.article!, name: 'brief' } };
  }, { brief: { collector: 'private collector settings' } });
  const file = await readTrialEval(path);
  expect(Object.keys(file.report.snapshot.artifacts).sort()).toEqual(['article', 'brief']);
  expect(await readFile(path, 'utf8')).not.toContain('private collector settings');
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
