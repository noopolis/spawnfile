import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { observation } from '../../testing/index.js';
import { rescoreStoredTrial } from './index.js';
import { fixture } from './fixture.js';

test('denies viewer/optimizer rescoring and preserves sealed-test access requirements', async () => {
  const { options } = await fixture();
  for (const audience of ['viewer', 'optimizer'] as const) await expect(rescoreStoredTrial({ ...options, access: { audience, phase: 'replay' } })).rejects.toThrow('requires evaluator');
  const sealed = await fixture(report => { report.phase = 'test'; });
  await expect(rescoreStoredTrial(sealed.options)).rejects.toThrow('Sealed test');
  await expect(rescoreStoredTrial({ ...sealed.options, access: { audience: 'operator', phase: 'replay',
    releaseTestResults: true, frozenCandidateIds: ['candidate'] } })).resolves.toMatchObject({ original: { phase: 'test' } });
});

test('rejects authenticated-but-malformed reports and mismatched trial/snapshot identities', async () => {
  for (const change of [
    report => { report.snapshot.closed = false; },
    report => { report.id = 'bad\0id'; },
    report => { report.candidateId = 'wrong'; },
    report => { report.snapshot.trialId = 'wrong'; },
    report => { report.snapshot.recordId = 'wrong'; },
  ] satisfies Parameters<typeof fixture>[0][]) {
    const { options } = await fixture(change);
    await expect(rescoreStoredTrial(options)).rejects.toThrow();
  }
});

test('rejects wrong-trial, duplicate/conflicting observations and inconsistent artifact digests', async () => {
  const native = observation();
  for (const events of [[{ ...native, trialId: 'wrong' }], [native, native],
    [native, { ...native, id: 'different' }]]) {
    const { options } = await fixture(report => { report.snapshot.events = events; });
    await expect(rescoreStoredTrial(options)).rejects.toThrow();
  }
  const { options } = await fixture(report => { report.snapshot.artifacts.article!.digest = 'sha256:wrong'; });
  await expect(rescoreStoredTrial(options)).rejects.toThrow('artifact digest');
  const valid = await fixture(report => { report.snapshot.events = [observation()]; });
  await expect(rescoreStoredTrial(valid.options)).resolves.toMatchObject({ status: 'pass' });
});

test('requires one original trial, never rescores a rescore or guesses among multiple original reports', async () => {
  const { options, store, report } = await fixture();
  await store.appendEvaluation('trial', { id: 'second-original', report });
  await expect(rescoreStoredTrial(options)).rejects.toThrow('exactly one');
  const missing = await fixture();
  const replay = await missing.store.readReplay('trial', missing.options.access);
  const withoutOriginal = { ...missing.store, readReplay: async () => ({ ...replay,
    evaluations: [{ id: 'only-rescore', visibility: 'evaluator' as const, digest: 'irrelevant', report: { schema: 'paideia.rescore.v1' } },
      { id: 'empty', visibility: 'evaluator' as const, digest: 'irrelevant', report: null }] }) };
  await expect(rescoreStoredTrial({ ...missing.options, store: withoutOriginal })).rejects.toThrow('exactly one');
});

test('digest tampering and truncated durable data cannot produce another evaluation', async () => {
  const corrupted = await fixture();
  const bytes = JSON.parse(await readFile(corrupted.originalPath, 'utf8')) as { report: { snapshot: { output: string } } };
  bytes.report.snapshot.output = 'TAMPERED';
  await writeFile(corrupted.originalPath, JSON.stringify(bytes));
  await expect(rescoreStoredTrial(corrupted.options)).rejects.toThrow('integrity');
  const truncated = await fixture();
  await writeFile(truncated.originalPath, '{"report":');
  await expect(rescoreStoredTrial(truncated.options)).rejects.toThrow();
  const tail = await fixture();
  const journal = join(tail.runRoot, 'events.jsonl');
  await appendFile(journal, '{"unfinished":');
  const before = await readFile(journal);
  await expect(rescoreStoredTrial(tail.options)).rejects.toThrow('truncated journal');
  expect(await readFile(journal)).toEqual(before);
  expect((await tail.store.readReplay('trial', tail.options.access)).evaluations).toHaveLength(1);
});
