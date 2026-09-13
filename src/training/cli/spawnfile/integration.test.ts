import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { candidateComponents } from '../../candidates/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { parseArguments } from '../arguments.js';
import { main } from '../commands.js';
import { cliFixture, datasetText, fixtureAdapter } from '../fixture.js';
import type { CliDependencies, InvocationIndex, SpawnfileCliIntegration } from '../types.js';
import { contextFixture, inventoryDigest } from './fixture.js';
import { prepareSpawnfileInputs } from './selection.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const context = await contextFixture(), cli = await cliFixture();
  roots.push(context.root, cli.root);
  const text = '# Policy\nKeep identity locked.\n\n## Prose\nBASE\n';
  await writeFile(join(context.root, 'AGENTS.md'), text);
  context.context.sources[0]!.sha256 = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  context.context.documents[0]!.sha256 = context.context.sources[0]!.sha256;
  context.context.project.sourceDigest = inventoryDigest(context.context);
  await context.save();
  const setup = 'setup:\n  profile: fixture/workspace\n  purpose: verify-preparation\n';
  await writeFile(join(cli.root, 'train.yaml'), datasetText([{ id: 'learning', group: 'a' }, { id: 'selection', group: 'b' }]) + setup);
  await writeFile(join(cli.root, 'test.yaml'), datasetText([{ id: 'sealed', group: 'c' }]) + setup);
  const seen: { phase: string; source: string; contextId: string }[] = [];
  const integration: SpawnfileCliIntegration = {
    id: 'fixture/workspace', version: '1',
    preparations: { 'fixture/workspace': { version: '1', unlockedPaths: [], validate(parameters) {
      if (parameters.purpose !== 'verify-preparation') throw new Error('Wrong preparation purpose');
    } } },
    editPolicies: { 'AGENTS.md': { headings: [['Policy', 'Prose']] }, 'SOUL.md': 'whole-file' },
    createAdapter(receipt, options) {
      expect(receipt.agent.id).toBe('agent:writer'); expect(options.model).toBe('gpt-5.5');
      const adapter = fixtureAdapter('prepared-native', cli.observedInstructions);
      return { ...adapter, capabilities: { ...adapter.capabilities, resources: ['instructions', 'supporting-files', 'native-skills'] } };
    },
    async prepareEnvironment(paths, signal, trial, receipt) {
      signal.throwIfAborted();
      expect(trial.record.setup?.purpose).toBe('verify-preparation');
      const source = await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8');
      expect(source).toContain('# Policy\nKeep identity locked.');
      expect(await readFile(join(paths.workspace, 'SOUL.md'), 'utf8')).toBe('An independent writer.\n');
      seen.push({ phase: trial.phase, source, contextId: receipt.agent.id });
      return {};
    },
  };
  const dependencies: CliDependencies = { ...cli.dependencies, spawnfile: integration,
    adapter: vi.fn(() => { throw new Error('Generic runtime fallback is forbidden'); }) };
  const args = ['train', '--spawnfile-context', context.path, '--train', 'train.yaml', '--test', 'test.yaml',
    '--editable', 'AGENTS.md', '--optimizer-model', 'claude-fable-5-1', '--validation-group', 'b',
    '--max-trials', '6', '--max-proposals', '1', '--timeout-ms', '15000'];
  return { context, cli, integration, dependencies, seen, args };
}

it('resolves registered fixtures and narrow edits during dry-run without constructing any execution boundary', async () => {
  const f = await fixture();
  f.integration.createAdapter = vi.fn(() => { throw new Error('No native construction'); });
  f.integration.prepareEnvironment = vi.fn(async () => { throw new Error('No compilation or auth'); });
  f.dependencies.inference = vi.fn(() => { throw new Error('No inference construction'); });
  expect(await main(['validate', 'train.yaml'], f.cli.io, f.dependencies)).toBe(0);
  expect(JSON.parse(f.cli.stdout.shift()!)).toMatchObject({ status: 'valid', records: 2 });
  expect(await main([...f.args, '--dry-run'], f.cli.io, f.dependencies)).toBe(0);
  const plan = JSON.parse(f.cli.stdout.join(''));
  expect(plan).toMatchObject({ modelCallsMade: 0, readiness: { integration: { id: 'fixture/workspace', version: '1' } } });
  for (const boundary of [f.integration.createAdapter, f.integration.prepareEnvironment, f.dependencies.inference]) expect(boundary).not.toHaveBeenCalled();
  await expect(stat(join(f.cli.root, '.runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  const selected = await prepareSpawnfileInputs(parseArguments([...f.args, '--dry-run']), f.cli.io, f.integration);
  expect(candidateComponents(selected.candidate).map(component => component.text)).toEqual(['\nBASE\n']);
  await expect(prepareSpawnfileInputs(parseArguments([...f.args, '--dry-run', '--editable', 'SOUL.md']), f.cli.io, f.integration))
    .rejects.toThrow('identity');
  await expect(prepareSpawnfileInputs(parseArguments([...f.args, '--dry-run']), f.cli.io, { ...f.integration, version: '' }))
    .rejects.toThrow('stable id');
});

it('delegates real DSPy trials to the registered preparation and persists frozen comparison and costs', async () => {
  const f = await fixture();
  expect(await main([...f.args, '--bridge-command', f.cli.bridge, '--out', 'out'], f.cli.io, f.dependencies)).toBe(0);
  expect(f.cli.stderr).toEqual([]);
  expect(f.dependencies.adapter).not.toHaveBeenCalled();
  expect(f.seen).toHaveLength(6);
  expect(f.seen.map(row => row.phase)).toEqual(['validation', 'train', 'train', 'validation', 'test', 'test']);
  expect(f.seen.at(-1)!.source).toContain('IMPROVED');
  const index = JSON.parse(await readFile(join(f.cli.root, 'out', 'invocation.json'), 'utf8')) as InvocationIndex;
  const store = await openExperimentStore(join(f.cli.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString());
  expect(report.heldOut.map((row: { meanScore: number }) => row.meanScore)).toEqual([0, 1]);
  expect(report.costPlan.schema).toBe('paideia.training-cost-plan.v1');
  expect(report.costs.usageCoverage).toBe('incomplete');
  expect(report.selected.resources.find((row: { sourcePath: string }) => row.sourcePath === 'SOUL.md').edit).toBe('locked');
});

it('rejects unsupported preparation before constructing native or inference clients', async () => {
  const f = await fixture();
  f.integration.preparations = {};
  f.integration.createAdapter = vi.fn(() => { throw new Error('Must not construct'); });
  f.dependencies.inference = vi.fn(() => { throw new Error('Must not construct'); });
  expect(await main([...f.args, '--bridge-command', f.cli.bridge, '--out', 'out'], f.cli.io, f.dependencies)).toBe(2);
  expect(f.cli.stderr.join('')).toContain('unsupported preparation');
  expect(f.integration.createAdapter).not.toHaveBeenCalled(); expect(f.dependencies.inference).not.toHaveBeenCalled();
  await expect(stat(join(f.cli.root, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
});
