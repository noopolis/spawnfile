import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArguments } from '../training/cli/arguments.js';
import { prepareNative as prepareCoreNative, resourceMappings } from '../training/cli/native.js';
import { main, trainingDependencies } from './trainingCli.js';
import { cliFixture, fixtureAdapter } from '../../fixtures/support/training/cli-fixture.js';
import { contextFixture } from '../../fixtures/support/training/spawnfile-fixture.js';

const roots: string[] = [];
const prepareNative = async (...[args, io, dependencies, ...rest]: Parameters<typeof prepareCoreNative>) =>
  prepareCoreNative(args, io, await trainingDependencies(dependencies), ...rest);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('explicit native resource and inference selection', () => {
  it('exposes import-safe CLI composition without changing process signal listeners', async () => {
    const f = await cliFixture(); roots.push(f.root);
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    expect(await main(['--help'], f.io, { subjects: {} })).toBe(0);
    expect(f.stdout.join('')).toContain('train');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  });
  it('executes canonical host context through the composed CLI without a receipt file', async () => {
    const f = await cliFixture(), context = await contextFixture(); roots.push(f.root, context.root);
    await rm(context.path);
    const adapter = fixtureAdapter('host-context', f.observedInstructions, 'pass');
    const createAdapter = vi.fn(() => ({ ...adapter, capabilities: { ...adapter.capabilities,
      resources: ['instructions' as const, 'supporting-files' as const, 'native-skills' as const] } }));
    const prepareEnvironment = vi.fn(async () => ({}));
    const code = await main(['evaluate', 'data.yaml', '--out', 'out'], f.io, { ...f.dependencies,
      spawnfileContext: context.context, spawnfile: { id: 'fixture', version: '1', createAdapter, prepareEnvironment } });
    expect(code, f.stderr.join('')).toBe(0);
    expect(createAdapter).toHaveBeenCalledWith(context.context, expect.objectContaining({ model: 'gpt-5.5' }));
    expect(prepareEnvironment).toHaveBeenCalledOnce();
    expect(f.observedInstructions).toEqual(['Write clearly.\n']);
    const index = JSON.parse(await readFile(join(f.root, 'out', 'invocation.json'), 'utf8'));
    expect(index).toMatchObject({ command: 'evaluate', trialIds: [expect.any(String)] });
    await expect(readFile(context.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('defaults every Markdown resource to locked and changes only explicitly selected files', () => {
    const locked = resourceMappings(parseArguments(['evaluate', 'x', '--instructions', 'AGENTS.md', '--supporting', 'skills/review.md', '--locked', 'policy.md']));
    expect(locked.map((resource) => resource.edit)).toEqual(['locked', 'locked', 'locked']);
    expect(locked[1]!.destinations).toEqual([{ kind: 'supporting-files', path: 'skills/review.md' }]);
    const editable = resourceMappings(parseArguments(['train', '--instructions', 'AGENTS.md', '--editable', 'AGENTS.md']));
    expect(editable[0]!.edit).toBe('whole-file');
    expect(editable[0]!.id).toBe(locked[0]!.id);
  });
  it.each([
    [], ['--instructions', 'a.md', '--instructions', 'a.md'], ['--instructions', 'a.md', '--editable', 'a.md', '--editable', 'a.md'],
    ['--instructions', 'a.md', '--editable', 'missing.md'], ['--instructions', 'a.md', '--locked', 'b.md', '--editable', 'b.md'],
    ['--instructions', 'Spawnfile'],
  ])('rejects undeclared/ambiguous edits and unsupported configuration: %j', (...flags) => {
    expect(() => resourceMappings(parseArguments(['train', ...flags]))).toThrow();
  });
  it('refuses a registered Daimon subject outside production-booted training and builds explicit judge/resource routes', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const args = parseArguments(['evaluate', 'data.yaml', '--runtime', 'daimon', '--model', 'explicit', '--instructions', 'AGENTS.md',
      '--out', 'out', '--judge', 'quality=explicit-judge', '--judge-citation-repairs', 'quality=1', '--resource', 'archive=archive']);
    await expect(prepareNative(args, fixture.io, {}, 1000)).rejects.toThrow('production-booted trials');
    const prepared = await prepareNative(args, fixture.io, { adapter: fixture.dependencies.adapter }, 1000);
    expect(prepared.inference!.capabilities.billing).toBe('subscription');
    expect(prepared.evaluation.judges.quality!.model).toBe('explicit-judge');
    expect(prepared.evaluation.judges.quality!.citationRepairs).toBe(1);
    expect(prepared.resources.archive).toBe(`${fixture.root}/archive`);
    await expect(prepared.evaluation.readText('unknown')).rejects.toThrow('not frozen');
    await prepared.closeInference();
    await expect(prepareNative(parseArguments(['evaluate', 'x', '--runtime', 'other']), fixture.io, {}, 1)).rejects.toThrow('Supported native runtimes');
  });
  it.each(['file', 'in-process'])('preserves registered Spawnfile %s context preparation while installing evaluation services', async mode => {
    const f = await cliFixture(), context = await contextFixture(); roots.push(f.root, context.root);
    const createAdapter = vi.fn(() => f.dependencies.adapter!('daimon', { model: 'gpt-5.5', timeoutMs: 1000 }));
    const prepareEnvironment = vi.fn(async () => ({ tools: [] }));
    if (mode === 'in-process') await rm(context.path);
    const native = await prepareNative(parseArguments(['evaluate', 'data.yaml', ...(mode === 'file' ? ['--spawnfile-context', context.path] : []), '--out', 'out']), f.io,
      { ...f.dependencies, ...(mode === 'in-process' ? { spawnfileContext: context.context } : {}), spawnfile: { id: 'fixture', version: '1', subjectRoot: context.root, createAdapter, prepareEnvironment } }, 1000);
    expect(createAdapter).toHaveBeenCalledWith(context.context, { model: 'gpt-5.5', timeoutMs: 1000 });
    expect(native.subjectRoot).toBe(context.root);
    const paths = { root: f.root, workspace: f.root, control: f.root, runtimeHome: f.root };
    const signal = new AbortController().signal;
    const trial = { id: 'trial', phase: 'train' as const, record: native.datasets.load('data.yaml', false).records[0]!,
      candidate: native.candidate, resources: {} };
    expect(await native.prepareEnvironment!(paths, signal, trial)).toEqual({ tools: [] });
    expect(prepareEnvironment).toHaveBeenCalledWith(paths, signal, trial, context.context, {});
    expect(native.evaluation.graders).toEqual({});
    await native.closeInference();
  });
});
