import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { main } from '../commands.js';
import { fixtureAdapter } from '../fixture.js';
import { openExperimentStore } from '../../storage/index.js';
import { afterEach, expect, it, vi } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { snapshotCandidate } from '../../candidates/index.js';
import type { NativePreparationContext } from '../../experiments/index.js';
import type { SpawnfileCliIntegration } from '../types.js';
import { contextFixture } from './fixture.js';
import { spawnfileEnvironment, type TrainingMomentCase, type TrainingMomentPreparation } from './moments.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await contextFixture(); roots.push(f.root);
  const candidate = await snapshotCandidate({ sourceRoot: f.root, resources: [{ id: 'instruction', sourcePath: 'AGENTS.md', edit: 'whole-file', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }] }] });
  const record = resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'paideia.dataset.v1', id: 'cases', checks: [{ id: 'yes', eval: 'equals', input: 'output.text', value: 'OK' }],
    records: [{ id: 'original', group: 'family', lineage: ['ancestor'], input: { prompt: 'Wake.' } }] }))).records[0]!;
  const moment: TrainingMomentCase = { version: 'spawnfile.training-moment-case.v1', projectRoot: f.root, agent: f.context.agent.id,
    example: 'train:original', role: 'train', dataset: 'declared', at: '2026-01-01T12:00:00Z', effectiveAt: '2026-01-01T12:00:01Z',
    wake: { surface: 'moltnet', room: 'work', from: 'editor', text: 'Wake.' }, group: 'family', lineage: 'ancestor', momentRoot: join(f.root, 'lowered'), hook: 'fixture/rewind' };
  const trial: NativePreparationContext = { id: 'trial', phase: 'train', candidate, resources: {}, record: { ...record, setup: { trainingMoment: moment } } };
  const prepare: TrainingMomentPreparation = vi.fn<TrainingMomentPreparation>(async (paths, _signal, trial, _context, moment) => {
    const momentRoot = join(paths.control, 'moment'); await mkdir(momentRoot);
    await writeFile(join(momentRoot, 'moment.json'), JSON.stringify({ version: 'spawnfile.materialized-moment.v1', status: 'materialized', agent: moment.agent,
      example: { id: trial.record.id, role: moment.role, dataset: moment.dataset }, at: moment.at, effectiveAt: moment.effectiveAt, leakCheck: { ok: true } }));
    await writeFile(join(momentRoot, 'leak-check.json'), JSON.stringify({ ok: true }));
    return { momentReceipt: { version: 'paideia.training-moment-prepared.v1', trialId: trial.id, example: moment.example, momentRoot, at: moment.effectiveAt } };
  });
  const integration: SpawnfileCliIntegration = { id: 'fixture', version: '1', createAdapter: vi.fn(), prepareEnvironment: vi.fn(async () => ({})), momentPreparations: { 'fixture/rewind': prepare } };
  async function paths() {
    const root = await mkdtemp(join(tmpdir(), 'moment-trial-')); roots.push(root);
    const paths = { root, workspace: join(root, 'workspace'), runtimeHome: join(root, 'runtime'), control: join(root, 'control') };
    await Promise.all([paths.workspace, paths.runtimeHome, paths.control].map(path => mkdir(path)));
    return paths;
  }
  const services = { grokSlots: { request: vi.fn(), accept: vi.fn() } };
  return { ...f, integration, trial, moment, prepare, paths, services, signal: new AbortController().signal };
}
it('dispatches each authored moment to fresh isolated trial state and preserves legacy preparation', async () => {
  const f = await fixture(), run = spawnfileEnvironment(f.integration, f.context, f.services);
  const first = await f.paths(), second = await f.paths();
  expect(await run(first, f.signal, f.trial)).toEqual({});
  expect(await run(second, f.signal, { ...f.trial, id: 'other' })).toEqual({});
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(first.control).not.toBe(second.control);
  await expect(run(first, f.signal, f.trial)).rejects.toThrow('not fresh');
  await run(second, f.signal, { ...f.trial, record: { ...f.trial.record, setup: undefined } });
  expect(f.integration.prepareEnvironment).toHaveBeenCalledOnce();
  // Both legacy preparation and moment hooks receive the experiment's own services, unchanged.
  expect(vi.mocked(f.integration.prepareEnvironment).mock.calls[0]![4]).toBe(f.services);
  expect(vi.mocked(f.prepare).mock.calls[0]![5]).toBe(f.services);
});
it.each(['role', 'example', 'agent', 'projectRoot', 'group', 'lineage', 'extra'] as const)('rejects authored metadata mutation %s before calling a hook', async key => {
  const f = await fixture();
  (f.trial.record.setup!.trainingMoment as Record<string, unknown>)[key] = 'invalid';
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), f.signal, f.trial)).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
});
it.each([
  ['validation', 'train'], ['validation', 'test'], ['test', 'train'], ['test', 'validation'], ['train', 'test'],
] as const)('rejects authored %s in evaluation phase %s before calling a hook', async (role, phase) => {
  const f = await fixture();
  f.moment.role = role; f.moment.example = `${role}:${f.trial.record.id}`;
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), f.signal, { ...f.trial, phase })).rejects.toThrow('identity mismatch');
  expect(f.prepare).not.toHaveBeenCalled();
});
it('requires authored train rewind evidence when evaluating an internal validation holdout', async () => {
  const f = await fixture(), original = f.prepare;
  f.integration.momentPreparations = { 'fixture/rewind': async (...args) => {
    const result = await original(...args), file = join(result.momentReceipt.momentRoot, 'moment.json');
    const evidence = JSON.parse(await readFile(file, 'utf8'));
    evidence.example.role = args[2].phase;
    await writeFile(file, JSON.stringify(evidence));
    return result;
  } };
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), f.signal, { ...f.trial, phase: 'validation' })).rejects.toThrow('evidence mismatch');
  expect(f.prepare).toHaveBeenCalledOnce();
});
it.each(['missing', 'inherited'])('requires an own declared hook (%s)', async mode => {
  const f = await fixture();
  f.integration.momentPreparations = mode === 'missing' ? undefined : Object.create({ 'fixture/rewind': f.prepare });
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), f.signal, f.trial)).rejects.toThrow('Undeclared');
});
it.each(['receipt', 'refused', 'leak', 'link', 'oversized', 'directory'])('rejects invalid preparation evidence: %s', async mutation => {
  const f = await fixture(), original = f.prepare;
  f.integration.momentPreparations = { 'fixture/rewind': async (...args) => {
    const result = await original(...args), root = result.momentReceipt.momentRoot;
    if (mutation === 'receipt') result.momentReceipt.trialId = 'other';
    if (mutation === 'refused') await writeFile(join(root, 'moment.json'), JSON.stringify({ status: 'refused' }));
    if (mutation === 'leak') await writeFile(join(root, 'leak-check.json'), JSON.stringify({ ok: false }));
    if (mutation === 'link') { await rm(root, { recursive: true }); await symlink(f.root, root); }
    if (mutation === 'oversized') await writeFile(join(root, 'moment.json'), ' '.repeat(2_000_001));
    if (mutation === 'directory') { await rm(join(root, 'moment.json')); await mkdir(join(root, 'moment.json')); }
    return result;
  } };
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), f.signal, f.trial)).rejects.toThrow();
});
it('rejects cancellation before and after hook work', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), controller.signal, f.trial)).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
  const next = new AbortController();
  f.integration.momentPreparations = { 'fixture/rewind': async (...args) => { const result = await f.prepare(...args); next.abort(); return result; } };
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), next.signal, f.trial)).rejects.toThrow();
});

it.each(['explicit', 'automatic', 'group'] as const)('executes %s validation through fake moment hooks before native trials', async mode => {
  const f = await fixture(), seen: Array<{ phase: string; moment: TrainingMomentCase }> = [], stdout: string[] = [], stderr: string[] = [];
  const original = f.prepare;
  f.integration.preparations = { 'fixture/rewind': { version: '1', unlockedPaths: ['trainingMoment'], validate() {} } };
  f.integration.unlockedSetupPaths = ['trainingMoment'];
  f.integration.createAdapter = () => {
    const adapter = fixtureAdapter('fake-native', [], 'pass');
    return { ...adapter, capabilities: { ...adapter.capabilities, resources: ['instructions', 'supporting-files', 'native-skills'] } };
  };
  f.integration.momentPreparations = { 'fixture/rewind': async (...args) => { seen.push({ phase: args[2].phase, moment: structuredClone(args[4]) }); return original(...args); } };
  await writeFile(join(f.root, 'variant.md'), 'IMPROVED\n');
  const authored = new Map<string, TrainingMomentCase>();
  const roles = mode === 'explicit' ? ['train', 'validation', 'test'] as const : ['train', 'test'] as const;
  for (const role of roles) {
    const ids = role === 'train' && mode !== 'explicit' ? ['train-a', 'train-z'] : [role];
    const records = ids.map(id => {
      const moment = { ...f.moment, example: `${role}:${id}`, role, dataset: role, group: id, lineage: id };
      authored.set(moment.example, moment);
      return { id, group: id, lineage: [id], setup: { trainingMoment: moment }, input: { prompt: moment.wake.text } };
    });
    await writeFile(join(f.root, `${role}.yaml`), JSON.stringify({ schema: 'paideia.dataset.v1', id: role,
      setup: { profile: 'fixture/rewind' }, checks: [{ id: 'yes', eval: 'equals', input: 'output.text', value: 'OK' }],
      ...(role === 'train' ? { training: { models: { unused: { provider: 'ollama', model: 'unused' } },
        ...(mode === 'explicit' ? { validation: 'validation.yaml' } : {}), test: 'test.yaml',
        comparison: { candidate: { name: 'authored', replacements: [{ resource: 'AGENTS.md', source: 'variant.md' }] } } } } : {}),
      records }));
  }
  const groupArgs = mode === 'group' ? ['--validation-group', 'train-a'] : [];
  expect(await main(['train', '--train', 'train.yaml', ...groupArgs, '--spawnfile-context', f.path, '--editable', 'AGENTS.md', '--out', 'out'],
    { cwd: f.root, stdout: text => { stdout.push(text); }, stderr: text => { stderr.push(text); } }, { spawnfile: f.integration }), stderr.join('')).toBe(0);
  expect(seen.map(entry => entry.phase)).toEqual(['train', 'train', 'validation', 'validation', 'test', 'test']);
  for (const entry of seen) expect(entry.moment).toEqual(authored.get(entry.moment.example));
  expect(seen.filter(entry => entry.phase === 'validation').map(entry => entry.moment.role)).toEqual(
    mode === 'explicit' ? ['validation', 'validation'] : ['train', 'train']);
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  const store = await openExperimentStore(join(f.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString());
  expect(report.partitions).toEqual(mode === 'explicit' ? { train: ['train'], validation: ['validation'], test: ['test'] } :
    { train: [mode === 'group' ? 'train-z' : 'train-a'], validation: [mode === 'group' ? 'train-a' : 'train-z'], test: ['test'] });
  expect(new Set(report.trials.map((trial: { paths: { control: string } }) => trial.paths.control)).size).toBe(6);
  expect(report.trials.every((trial: { snapshot: { context: unknown } }) => trial.snapshot.context !== undefined)).toBe(true);
  expect(JSON.parse(stdout.at(-1)!).nativeTrials).toBe(6);
});
it.each(['version', 'trialId', 'example', 'momentRoot', 'at', 'absent'])('binds every receipt field: %s', async field => {
  const f = await fixture(), original = f.prepare;
  f.integration.momentPreparations = { 'fixture/rewind': async (...args) => {
    const result = await original(...args);
    if (field === 'absent') delete (result as { momentReceipt?: unknown }).momentReceipt;
    else (result.momentReceipt as unknown as Record<string, unknown>)[field] = 'wrong';
    return result;
  } };
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), f.signal, f.trial)).rejects.toThrow('receipt mismatch');
});
it.each(['version', 'agent', 'at', 'effectiveAt', 'id', 'role', 'dataset', 'leak', 'example'])('binds rewind evidence field: %s', async field => {
  const f = await fixture(), original = f.prepare;
  f.integration.momentPreparations = { 'fixture/rewind': async (...args) => {
    const result = await original(...args), file = join(result.momentReceipt.momentRoot, 'moment.json');
    const evidence = JSON.parse(await readFile(file, 'utf8'));
    if (['id', 'role', 'dataset'].includes(field)) evidence.example[field] = 'wrong';
    else if (field === 'leak') delete evidence.leakCheck;
    else if (field === 'example') delete evidence.example;
    else evidence[field] = 'wrong';
    await writeFile(file, JSON.stringify(evidence));
    return result;
  } };
  await expect(spawnfileEnvironment(f.integration, f.context, f.services)(await f.paths(), f.signal, f.trial)).rejects.toThrow('evidence mismatch');
});
