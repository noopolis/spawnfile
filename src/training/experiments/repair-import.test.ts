import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateComponents, snapshotCandidate } from '../candidates/index.js';
import { openExperimentStore } from '../storage/index.js';
import { fixture, criteria } from './replay/fixture.js';
import { trainingDigest } from './training/checkpoint.js';
import { importMeasurementCaptures, readParentCheckpoints } from './repair/index.js';
import { repairDigest, type MeasurementRepairReceipt } from './repair/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(change?: Parameters<typeof fixture>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'paideia-import-')); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), 'Original prompt');
  const baseline = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const dataset = criteria();
  const f = await fixture(report => { report.candidateId = baseline.id; report.stop!.quiescence = 'confirmed'; change?.(report); });
  // fixture's run manifest uses its fixed candidate; establish a genuine matching run for this integration fixture.
  const parent = join(root, 'parent'), store = await openExperimentStore(parent);
  const replay = await f.store.readReplay('trial', { audience: 'operator', phase: 'replay' });
  await store.createRun({ ...replay.manifest, candidateId: baseline.id });
  for (const event of replay.events) await store.appendEvent('trial', { id: event.id, payload: event.payload }, event.visibility);
  for (const evaluation of replay.evaluations) await store.appendEvaluation('trial', { id: evaluation.id, report: evaluation.report }, evaluation.visibility);
  await store.putBlob('trial', JSON.stringify(dataset.records[0]), 'evaluator');
  await store.putBlob('trial', JSON.stringify(baseline), 'evaluator');
  await store.putBlob('trial', 'raw non-JSON text', 'evaluator');
  const command = { schema: 'paideia.command-checkpoint.v1', identity: 'old', id: 'parent' };
  const state = { identity: 'training', recoveries: 0, entries: { 'call-1': { id: 'trial', report: JSON.parse(JSON.stringify(f.report)) } } };
  const host = { entries: [{ request: { id: 'call-1', method: 'evaluate', params: { split: 'train', caseId: 'story',
    components: Object.fromEntries(candidateComponents(baseline).map(component => [component.id, component.text])) } } }] };
  const sha = repairDigest('fixed');
  const receipt: MeasurementRepairReceipt = { version: 'paideia.measurement-repair.v1', parent: { root: parent, imageId: sha,
    manifestDigest: sha, experimentId: 'parent', executionIdentity: 'old', trainingIdentity: 'training',
    checkpoints: { command: sha, training: sha, host: sha, optimizer: sha } },
  current: { imageId: sha, adapterId: 'daimon-native', canonicalSourceDigest: sha },
  compatibility: { version: 'spawnfile.daimon-dspy-compatibility.v1', digest: sha, components: {}, inputs: {} } };
  await mkdir(join(parent, 'checkpoint'));
  async function save() {
    for (const [name, value] of Object.entries({ command, training: { state, digest: trainingDigest(state) }, host, optimizer: {} })) {
      const bytes = JSON.stringify(value); await writeFile(join(parent, 'checkpoint', `${name}.json`), bytes);
      receipt.parent.checkpoints[name as keyof typeof receipt.parent.checkpoints] = repairDigest(bytes);
    }
  }
  await save();
  const target = await openExperimentStore(join(root, 'child'));
  const options = { receipt, store: target, baseline, datasets: { train: dataset, validation: dataset } };
  return { ...f, root, parent, source: store, target, options, state, command, host, save };
}

it('copies a verified capture append-only with exact blob/event/evaluation identity', async () => {
  const f = await setup();
  const before = await readFile(join(f.parent, 'checkpoint/training.json'));
  expect(await importMeasurementCaptures(f.options)).toEqual([f.state.entries['call-1'].report]);
  expect(await importMeasurementCaptures(f.options)).toHaveLength(1);
  const access = { audience: 'operator' as const, phase: 'replay' as const };
  expect(await f.target.readReplay('trial', access)).toEqual(await f.source.readReplay('trial', access));
  expect(await f.target.listBlobs('trial', access)).toEqual(await f.source.listBlobs('trial', access));
  expect(await readFile(join(f.parent, 'checkpoint/training.json'))).toEqual(before);
});

it('rejects changed checkpoint bytes, identities, frozen selection and impossible counters', async () => {
  const f = await setup();
  await writeFile(join(f.parent, 'checkpoint/host.json'), '{}');
  await expect(readParentCheckpoints(f.options.receipt)).rejects.toThrow('bytes changed'); await f.save();
  f.command.identity = 'changed'; await f.save();
  await expect(readParentCheckpoints(f.options.receipt)).rejects.toThrow('identities'); f.command.identity = 'old';
  Object.assign(f.state, { optimizer: {} }); await f.save();
  await expect(readParentCheckpoints(f.options.receipt)).rejects.toThrow('frozen selection');
  Reflect.deleteProperty(f.state, 'optimizer'); f.state.recoveries = -1; await f.save();
  await expect(readParentCheckpoints(f.options.receipt)).rejects.toThrow('bookkeeping');
});

it('rejects missing native work, callback identity drift, components and partition changes before writes', async () => {
  const f = await setup();
  const original = structuredClone(f.state.entries), callback = structuredClone(f.host.entries[0]!);
  Reflect.deleteProperty(f.state.entries['call-1'], 'report'); await f.save();
  await expect(importMeasurementCaptures(f.options)).rejects.toThrow('settled development');
  f.state.entries = structuredClone(original); f.host.entries[0]!.request.method = 'generate'; await f.save();
  await expect(importMeasurementCaptures(f.options)).rejects.toThrow('evaluation callback');
  f.host.entries[0] = structuredClone(callback); f.host.entries[0]!.request.params.components = {}; await f.save();
  await expect(importMeasurementCaptures(f.options)).rejects.toThrow('component keys');
  f.host.entries[0] = structuredClone(callback); f.host.entries[0]!.request.params.caseId = 'other'; await f.save();
  await expect(importMeasurementCaptures(f.options)).rejects.toThrow('split or case');
  f.host.entries[0] = structuredClone(callback); f.host.entries[0]!.request.params.components['instructions#file'] = 'Changed'; await f.save();
  await expect(importMeasurementCaptures(f.options)).rejects.toThrow('candidate');
  f.host.entries[0] = callback; await f.save();
  await expect(importMeasurementCaptures({ ...f.options, datasets: { ...f.options.datasets,
    train: { ...f.options.datasets.train, records: [] } } })).rejects.toThrow('partition');
  f.state.entries['call-1'].report.status = 'error'; await f.save();
  await expect(importMeasurementCaptures(f.options)).rejects.toThrow('immutable capture');
  await expect(f.target.readReplay('trial', { audience: 'operator', phase: 'replay' })).rejects.toThrow();
});

it('rejects unverified native closure and different protected records without importing', async () => {
  const f = await setup(report => { report.stop!.quiescence = 'unknown'; });
  await expect(importMeasurementCaptures(f.options)).rejects.toThrow('closure');
  const other = await setup();
  const changed = structuredClone(other.options.datasets.train); changed.records[0]!.input = { prompt: 'Changed' };
  await expect(importMeasurementCaptures({ ...other.options, datasets: { ...other.options.datasets, train: changed } })).rejects.toThrow('protected record');
  const empty = await setup(); empty.state.entries = {} as typeof empty.state.entries; await empty.save();
  await expect(importMeasurementCaptures(empty.options)).rejects.toThrow('bounded native');
});
