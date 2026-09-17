import { afterEach, expect, it, vi } from 'vitest';
import { chmod, link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { childFixture } from './fixture.js';
import { grokLaunchFrom } from '../grok-fixtures.js';
import { nativeTrialArtifactsRoot } from '../receipt/index.js';
import { ensureNativeTrialArtifacts, nativeChildArguments, nativeChildEnvironment, validateChildPaths } from './arguments.js';
import { loadNativeLaunch } from '../container/index.js';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const f = await childFixture(); roots.push(f.root); return f; }
it('uses actual immutable worker/bootstrap and declared launch argument paths', async () => {
  const f = await fixture(); const args = nativeChildArguments(f.launch, f.input.trialId, 1234);
  expect(args).toContain(join(f.launch.bootstrap!.root, f.launch.bootstrap!.entrypoint));
  expect(args.slice(args.indexOf('--launch'), args.indexOf('--launch') + 2)).toEqual(['--launch', f.launch.receiptFile]);
  expect(args.slice(-4)).toEqual(['--timeout-ms', '1234', '--schedule-override', 'disabled']);
  delete f.launch.bootstrap; expect(nativeChildArguments(f.launch, f.input.trialId, 1234)).toContain(join(f.launch.workerRoot, 'worker/cli.js'));
});
it('separates each Grok trial inside the shared slot control root and leaves Codex control roots untouched', async () => {
  const f = await fixture();
  // Codex preparation already creates one control root per trial, so nothing moves and nothing is created.
  expect(await ensureNativeTrialArtifacts(f.launch, f.input.trialId)).toBe(f.launch.controlRoot);
  expect(nativeChildArguments(f.launch, f.input.trialId, 1234)).toContain(join(f.launch.controlRoot, 'evidence.json'));
  const grok = await grokLaunchFrom(f.launch, f.root); await f.save();
  const trial = await ensureNativeTrialArtifacts(f.launch, f.input.trialId);
  expect(trial).toBe(nativeTrialArtifactsRoot(grok, f.input.trialId));
  expect(trial.startsWith(`${grok.controlRoot}/`)).toBe(true);
  expect(nativeChildArguments(f.launch, f.input.trialId, 1234)).toContain(join(trial, 'evidence.json'));
  await writeFile(join(trial, 'evidence.json'), '{}', { flag: 'wx', mode: 0o600 });
  // The slot supervisor's recycle only wipes Daimon's store, so a repeated trial identity must fail rather than collide.
  await expect(ensureNativeTrialArtifacts(f.launch, f.input.trialId)).rejects.toThrow('EEXIST');
  const next = await ensureNativeTrialArtifacts(f.launch, 'another-trial');
  expect(next).not.toBe(trial);
  await writeFile(join(next, 'evidence.json'), '{}', { flag: 'wx', mode: 0o600 });
});

it('loads literal declared environment without provider settings or shell interpolation', async () => {
  const f = await fixture(); vi.stubEnv('OPENAI_API_KEY', 'never-inherit'); vi.stubEnv('LC_ALL', undefined);
  await writeFile(f.launch.envFile, '# comment\n\nTOKEN=literal $() and "quotes"\n');
  expect(await nativeChildEnvironment(f.launch)).toMatchObject({ TOKEN: 'literal $() and "quotes"' });
  expect(await nativeChildEnvironment(f.launch)).not.toHaveProperty('OPENAI_API_KEY');
  for (const bad of ['MISSING_VALUE', 'A=1\nA=2']) { await writeFile(f.launch.envFile, bad); await expect(nativeChildEnvironment(f.launch)).rejects.toThrow('explicit native child environment'); }
});
it('requires source=target and safely staged caller-owned credential leaves', async () => {
  const f = await fixture(); await validateChildPaths(f.launch);
  f.launch.workspace.target = '/foreign'; await expect(validateChildPaths(f.launch)).rejects.toThrow('source and target'); f.launch.workspace.target = f.launch.workspace.source;
  const directory = join(f.launch.projections[0]!.target, '.daimon-inbound'), target = join(directory, 'codex-auth');
  await mkdir(directory, { mode: 0o700 }); await writeFile(target, 'opaque-unit-value', { mode: 0o600 });
  f.launch.credentials = [{ source: '/run/provisioned-unit-auth', target }]; await validateChildPaths(f.launch);
  await chmod(directory, 0o755); await expect(validateChildPaths(f.launch)).rejects.toThrow('directory'); await chmod(directory, 0o700);
  await chmod(target, 0o644); await expect(validateChildPaths(f.launch)).rejects.toThrow('safely staged'); await chmod(target, 0o600);
  await link(target, join(directory, 'hardlink')); await expect(validateChildPaths(f.launch)).rejects.toThrow('safely staged');
  await rm(join(directory, 'hardlink')); await rm(target); await symlink('/outside', target); await expect(validateChildPaths(f.launch)).rejects.toThrow('safely staged');
});
it('permits only child fresh home/memory data under the exact materialized workspace parent', async () => {
  const f = await fixture(); const home = join(f.root, 'home'); await mkdir(home, { mode: 0o700 });
  f.launch.projections[0] = { role: 'home', source: home, target: home }; await f.save();
  await expect(loadNativeLaunch(f.input)).rejects.toThrow('fresh trial data');
  expect((await loadNativeLaunch(f.input, true)).projections[0]!.source).toBe(home);
  const elsewhere = join(f.root, 'other-trial'); await mkdir(elsewhere, { mode: 0o700 });
  f.launch.projections[0]!.source = elsewhere; f.launch.projections[0]!.target = elsewhere; await f.save();
  await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('fresh trial data');
  f.launch.projections[0]!.source = home; f.launch.projections[0]!.target = home;
  f.launch.projections[0]!.role = 'transport'; f.launch.projections[1]!.role = 'home'; await f.save();
  await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('fresh trial data');
});

it('binds HOME to the fresh verified subject projection and rejects ambient or env-file overrides', async () => {
  const f = await fixture(); vi.stubEnv('HOME', '/operator/home');
  const home = f.launch.projections.find(row => row.role === 'home')!;
  expect((await nativeChildEnvironment(f.launch)).HOME).toBe(home.target);
  await writeFile(f.launch.envFile, 'HOME=/operator/home\n');
  await expect(nativeChildEnvironment(f.launch)).rejects.toThrow('explicit native child environment');
  await writeFile(f.launch.envFile, '');
  home.target = '/other'; await expect(nativeChildEnvironment(f.launch)).rejects.toThrow('home projection');
  f.launch.projections = f.launch.projections.filter(row => row.role !== 'home');
  await expect(nativeChildEnvironment(f.launch)).rejects.toThrow('home projection');
});
