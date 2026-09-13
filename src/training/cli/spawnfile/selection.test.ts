import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../commands.js';
import { parseArguments } from '../arguments.js';
import { datasetText } from '../fixture.js';
import type { CliIO } from '../types.js';
import { contextFixture } from './fixture.js';
import { prepareSpawnfileInputs } from './selection.js';
import * as candidates from '../../candidates/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await contextFixture(); roots.push(f.root);
  const stdout: string[] = [], stderr: string[] = [];
  const io: CliIO = { cwd: f.root, stdout: text => { stdout.push(text); }, stderr: text => { stderr.push(text); } };
  const args = ['train', '--spawnfile-context', f.path, '--editable', 'AGENTS.md', '--out', 'out'];
  return { ...f, stdout, stderr, io, args };
}

describe('Spawnfile dry-run selection', () => {
  it('preserves canonical system/identity/skill files and honors only selected editable resources', async () => {
    const f = await fixture();
    const selected = await prepareSpawnfileInputs(parseArguments([...f.args, '--resource', 'archive=fixtures',
      '--judge', 'quality=model', '--judge-citation-repairs', 'quality=1']), f.io);
    expect(selected.citationRepairs).toEqual({ quality: 1 });
    expect(selected.resources).toEqual({ archive: join(f.root, 'fixtures') });
    expect(selected.model).toBe('gpt-5.5');
    expect(selected.candidate.resources.map(resource => [resource.sourcePath, resource.edit]))
      .toEqual([['AGENTS.md', 'whole-file'], ['SOUL.md', 'locked'], ['SKILL.md', 'locked']]);
    expect(selected.readiness.runnable).toBe(false);
    const skill = await prepareSpawnfileInputs(parseArguments([...f.args, '--editable', 'SKILL.md', '--model', 'explicit-override']), f.io);
    expect(skill.candidate.resources.at(-1)!.edit).toBe('whole-file');
    expect(skill.model).toBe('explicit-override');
    const locked = await prepareSpawnfileInputs(parseArguments([...f.args.slice(0, 3), '--out', 'out']), f.io);
    expect(locked.candidate.resources.every(resource => resource.edit === 'locked')).toBe(true);
  });
  it('rejects source drift occurring after receipt verification but before candidate capture', async () => {
    const f = await fixture(), original = candidates.snapshotCandidate;
    vi.spyOn(candidates, 'snapshotCandidate').mockImplementation(async options => {
      await writeFile(join(f.root, 'AGENTS.md'), 'Changed during candidate selection.\n');
      return original(options);
    });
    await expect(prepareSpawnfileInputs(parseArguments(f.args), f.io)).rejects.toThrow('changed while selecting');
  });
  it.each([['--instructions', 'fake.md'], ['--source-root', '.'], ['--runtime', 'codex'], ['--editable', 'SOUL.md'],
    ['--editable', 'AGENTS.md'], ['--editable', 'missing.md']])('rejects overridden canonical identity or ambiguous edits %j', async (...flags) => {
    const f = await fixture();
    await expect(prepareSpawnfileInputs(parseArguments([...f.args, ...flags]), f.io)).rejects.toThrow();
  });
  it('requires explicit model when runtime defaults are unresolved', async () => {
    const f = await fixture(); f.context.agent.model = null; await f.save();
    await expect(prepareSpawnfileInputs(parseArguments(f.args), f.io)).rejects.toThrow('--model');
  });
  it('runs the actual CLI receiver dry-run but never falls back to generic Pi execution', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'train.yaml'), datasetText([{ id: 'a', group: 'a' }, { id: 'b', group: 'b' }]));
    await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'x', group: 'x' }]).replace('id: example', 'id: sealed'));
    const args = [...f.args, '--train', 'train.yaml', '--test', 'test.yaml', '--optimizer-model', 'claude-fable-5-1'];
    const adapter = vi.fn(() => { throw new Error('Must not construct a runtime'); });
    expect(await main([...args, '--dry-run'], f.io, { adapter })).toBe(0);
    const plan = JSON.parse(f.stdout.join(''));
    expect(plan).toMatchObject({ schema: 'paideia.training-cost-plan.v1', modelCallsMade: 0,
      readiness: { runnable: false }, spawnfile: { agent: { id: 'agent:writer' } } });
    expect(await main(args, f.io, { adapter })).toBe(2);
    expect(adapter).not.toHaveBeenCalled();
    expect(f.stderr.join('')).toContain('isolated preparation integration');
  });
});
