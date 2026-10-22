import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeTrialArtifactsRoot } from '../receipt/index.js';
import { bindTrialPathsToSlot, nativeSubjectScratch, nativeTrialInputsRoot } from './layout.js';
import { codexSubject, grokContextRoot, grokSlotRoot, grokSubject, trialRoots } from './fixtures.js';

const minted = { expectedNonce: 'd'.repeat(64), minGeneration: 4 };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-layout-')));
  roots.push(root);
  const slot = { workspace: join(root, 'slot/workspace'), home: join(root, 'slot/runtime-home') };
  const trial = { workspace: join(root, 'trial/workspace'), runtimeHome: join(root, 'trial/runtime') };
  for (const path of [...Object.values(slot), ...Object.values(trial)]) await mkdir(path, { recursive: true });
  await writeFile(join(trial.workspace, 'AGENTS.md'), 'materialized');
  await writeFile(join(slot.home, 'keep'), 'slot bytes');
  return { root, slot, trial, subject: { roots: slot } };
}

describe('bindTrialPathsToSlot', () => {
  it('relocates both trial paths onto the canonical slot directories without touching slot bytes', async () => {
    const f = await layout();
    await bindTrialPathsToSlot(f.trial, f.subject);
    expect(await realpath(f.trial.workspace)).toBe(f.slot.workspace);
    expect(await realpath(f.trial.runtimeHome)).toBe(f.slot.home);
    expect(await readlink(f.trial.workspace)).toBe(f.slot.workspace);
    expect(await readFile(join(f.slot.home, 'keep'), 'utf8')).toBe('slot bytes');
    // Rebinding replaces only the link, never follows it into the slot.
    await bindTrialPathsToSlot(f.trial, f.subject);
    expect(await readFile(join(f.slot.home, 'keep'), 'utf8')).toBe('slot bytes');
    expect((await lstat(f.trial.runtimeHome)).isSymbolicLink()).toBe(true);
  });

  it('creates an absent trial entry', async () => {
    const f = await layout();
    await rm(f.trial.workspace, { recursive: true });
    await bindTrialPathsToSlot(f.trial, f.subject);
    expect(await realpath(f.trial.workspace)).toBe(f.slot.workspace);
  });

  it('refuses non-canonical, missing or non-directory slot paths before changing anything', async () => {
    const f = await layout();
    const alias = join(f.root, 'alias');
    await symlink(f.slot.workspace, alias);
    await writeFile(join(f.root, 'file'), '');
    for (const workspace of [alias, join(f.root, 'missing'), join(f.root, 'file'), 'relative/workspace']) {
      await expect(bindTrialPathsToSlot(f.trial, { roots: { ...f.slot, workspace } })).rejects.toThrow();
    }
    expect(await readdir(f.trial.workspace)).toEqual(['AGENTS.md']);
    expect((await lstat(f.trial.runtimeHome)).isDirectory()).toBe(true);
  });

  it('refuses overlapping slot roots and trial paths that are, contain or sit inside a slot directory', async () => {
    const f = await layout();
    await expect(bindTrialPathsToSlot(f.trial, { roots: { workspace: f.slot.workspace, home: f.slot.workspace } })).rejects.toThrow('disjoint');
    await expect(bindTrialPathsToSlot(f.trial, { roots: { workspace: join(f.root, 'slot'), home: f.slot.home } })).rejects.toThrow('disjoint');
    for (const trial of [{ ...f.trial, workspace: f.slot.workspace }, { ...f.trial, workspace: join(f.slot.workspace, 'nested') },
      { ...f.trial, runtimeHome: join(f.root, 'slot') }]) {
      await mkdir(trial.workspace, { recursive: true });
      await expect(bindTrialPathsToSlot(trial, f.subject)).rejects.toThrow('leased slot directory');
    }
    // A trial path reached through a symlinked parent is compared by where it really lives.
    await symlink(f.slot.workspace, join(f.root, 'via'));
    await expect(bindTrialPathsToSlot({ ...f.trial, workspace: join(f.root, 'via', 'x') }, f.subject)).rejects.toThrow('leased slot directory');
    await expect(bindTrialPathsToSlot({ ...f.trial, workspace: 'relative' }, f.subject)).rejects.toThrow('absolute');
    expect(await readFile(join(f.slot.home, 'keep'), 'utf8')).toBe('slot bytes');
  });
});

describe('nativeTrialInputsRoot', () => {
  it('places Codex inputs beside the per-trial control root inside the trial runtime', () => {
    const subject = codexSubject(trialRoots());
    expect(nativeTrialInputsRoot(subject, 'trial-a')).toBe('/trials/t1/runtime/native/root-control/inputs');
  });

  it('places Grok inputs per trial inside the denied context root, apart from the artifacts subtree', () => {
    const subject = grokSubject(minted);
    const a = nativeTrialInputsRoot(subject, 'trial-a');
    expect(a).toMatch(new RegExp(`^${grokContextRoot}/trials/trial-[a-f0-9]{32}$`, 'u'));
    expect(nativeTrialInputsRoot(subject, 'trial-b')).not.toBe(a);
    expect(nativeTrialInputsRoot(subject, '../../escape')).toMatch(/^\/run\/paideia\/trials\/trial-[a-f0-9]{32}$/u);
    const launchLike = { agent: subject.agent, controlRoot: subject.roots.control } as Parameters<typeof nativeTrialArtifactsRoot>[0];
    expect(nativeTrialArtifactsRoot(launchLike, 'trial-a').startsWith(`${grokSlotRoot}/state/paideia-trials/`)).toBe(true);
  });

  it('refuses a Grok context root the broker does not deny', () => {
    const subject = grokSubject(minted);
    expect(() => nativeTrialInputsRoot({ ...subject, roots: { ...subject.roots, context: '/run/open' } }, 't')).toThrow('denied context');
    const { context: _, ...rest } = subject.roots;
    expect(() => nativeTrialInputsRoot({ ...subject, roots: rest }, 't')).toThrow('denied context');
    expect(() => nativeTrialInputsRoot({ ...subject, broker: undefined }, 't')).toThrow('denied context');
    const runRoot = { ...subject, roots: { ...subject.roots, context: '/run/training/run' } };
    expect(() => nativeTrialInputsRoot(runRoot, 't')).toThrow('denied context');
  });
});

describe('nativeSubjectScratch', () => {
  it('keeps Grok scratch inside the single home projection', () => {
    const subject = grokSubject(minted);
    expect(nativeSubjectScratch(subject, 'memory')).toBe(`${grokSlotRoot}/runtime-home/paideia/memory`);
    expect(nativeSubjectScratch(subject, 'transport')).toBe(`${grokSlotRoot}/runtime-home/paideia/transport`);
    expect(() => nativeSubjectScratch({ ...subject, projections: [...subject.projections, { role: 'memory', source: '/m' }] }, 'memory'))
      .toThrow('exactly its slot runtime home');
    expect(() => nativeSubjectScratch({ ...subject, projections: [] }, 'memory')).toThrow('exactly its slot runtime home');
  });

  it('uses the Codex subject\'s own projections and refuses a missing or duplicated one', () => {
    const subject = codexSubject(trialRoots());
    expect(nativeSubjectScratch(subject, 'memory')).toBe('/trials/t1/memory');
    expect(nativeSubjectScratch(subject, 'transport')).toBe('/trials/t1/runtime/native/moltnet');
    expect(() => nativeSubjectScratch({ ...subject, projections: subject.projections.filter(row => row.role !== 'memory') }, 'memory'))
      .toThrow('exactly one memory');
    expect(() => nativeSubjectScratch({ ...subject, projections: [...subject.projections, subject.projections[2]!] }, 'transport'))
      .toThrow('exactly one transport');
  });
});
