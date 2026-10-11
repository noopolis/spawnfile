import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { parseArguments } from './arguments.js';
import { prepareNative, resourceMappings } from './native.js';
import { cliFixture } from './fixture.js';
import { contextFixture } from './spawnfile/fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('explicit native resource and inference selection', () => {
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
  it('builds the actual default adapter capabilities and explicit judge/resource routes without invoking them', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    for (const runtime of ['codex', 'daimon']) {
      const args = parseArguments(['evaluate', 'data.yaml', '--runtime', runtime, '--model', 'explicit', '--instructions', 'AGENTS.md',
        '--out', 'out', '--judge', 'quality=explicit-judge', '--judge-citation-repairs', 'quality=1', '--resource', 'archive=archive']);
      const prepared = await prepareNative(args, fixture.io, {}, 1000);
      expect(prepared.adapter.id).toBe(runtime);
      expect(prepared.inference!.capabilities.billing).toBe('subscription');
      expect(prepared.evaluation.judges.quality!.model).toBe('explicit-judge');
      expect(prepared.evaluation.judges.quality!.citationRepairs).toBe(1);
      expect(prepared.resources.archive).toBe(`${fixture.root}/archive`);
      await expect(prepared.evaluation.readText('unknown')).rejects.toThrow('not frozen');
    }
    await expect(prepareNative(parseArguments(['evaluate', 'x', '--runtime', 'other']), fixture.io, {}, 1)).rejects.toThrow('Supported native runtimes');
  });
  it('preserves registered Spawnfile preparation while installing evaluation services', async () => {
    const f = await cliFixture(), context = await contextFixture(); roots.push(f.root, context.root);
    const createAdapter = vi.fn(() => f.dependencies.adapter!('daimon', { model: 'gpt-5.5', timeoutMs: 1000 }));
    const prepareEnvironment = vi.fn(async () => ({ tools: [] }));
    const native = await prepareNative(parseArguments(['evaluate', 'data.yaml', '--spawnfile-context', context.path, '--out', 'out']), f.io,
      { ...f.dependencies, spawnfile: { id: 'fixture', version: '1', subjectRoot: context.root, createAdapter, prepareEnvironment } }, 1000);
    expect(createAdapter).toHaveBeenCalledWith(context.context, { model: 'gpt-5.5', timeoutMs: 1000 });
    expect(native.subjectRoot).toBe(context.root);
    const paths = { root: f.root, workspace: f.root, control: f.root, runtimeHome: f.root };
    const signal = new AbortController().signal;
    const trial = { id: 'trial', phase: 'train' as const, record: native.datasets.load('data.yaml', false).records[0]!,
      candidate: native.candidate, resources: {} };
    expect(await native.prepareEnvironment!(paths, signal, trial)).toEqual({ tools: [] });
    expect(prepareEnvironment).toHaveBeenCalledWith(paths, signal, trial, context.context);
    expect(native.evaluation.graders).toEqual({});
    await native.closeInference();
  });
});
