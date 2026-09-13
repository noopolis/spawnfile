import { expect, test } from 'vitest';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchFixture } from '../test-fixtures.js';
import { loadNativeLaunch } from './manifest.js';

test('fresh explicit projections preserve candidate bytes and reject unsafe launch sources', async () => {
  const f = await launchFixture();
  try {
    expect(await loadNativeLaunch(f.input)).toEqual(f.launch);
    await expect(loadNativeLaunch({ ...f.input, model: 'other' })).rejects.toThrow('model');
    await expect(loadNativeLaunch({ ...f.input, tools: [{} as never] })).rejects.toThrow('replace');
    await expect(loadNativeLaunch({ ...f.input, instructions: 'changed' })).rejects.toThrow('candidate');
    const original = structuredClone(f.launch);
    const mutations = [
      { workspace: { ...original.workspace, source: join(f.root, 'control') } },
      { instructions: { ...original.instructions, sha256: 'a'.repeat(64) } },
      { configSha256: 'f'.repeat(64) }, { controlRoot: f.input.workspacePath }, { controlRoot: f.input.runtimeHomePath },
      { config: join(f.input.workspacePath, 'AGENTS.md') },
      { projections: [...original.projections, { role: 'state' as const, source: join(f.root, 'control'), target: '/untrusted' }] },
      { projections: [...original.projections, { role: 'state' as const, source: f.input.runtimeHomePath, target: '/broad' }] },
      { projections: [...original.projections, { role: 'state' as const, source: join(f.input.runtimeHomePath, 'native/inputs'), target: '/inputs' }] },
      { projections: [...original.projections, { role: 'state' as const, source: original.controlRoot, target: '/control-alias' }] },
      { projections: [...original.projections, { role: 'state' as const, source: original.projections[0]!.source, target: '/native/workspace/home-alias' }] },
      { projections: [...original.projections, { role: 'state' as const, source: original.projections[1]!.source, target: '/native/home/alias' }] },
      { projections: [...original.projections, { role: 'state' as const, source: original.projections[1]!.source, target: original.projections[1]!.target }] },
      ...['/run', '/run/docker.sock', '/run/paideia/config.json', '/opt/paideia/native/alias'].map(target => ({ workspace: { ...original.workspace, target } })),
      { workerRoot: '/' }, { workerRoot: join(f.root, 'control') },
    ];
    for (const mutation of mutations) {
      Object.assign(f.launch, structuredClone(original), mutation); await f.save(); await expect(loadNativeLaunch(f.input)).rejects.toThrow();
    }
    Object.assign(f.launch, original); await f.save();
    await writeFile(join(f.launch.controlRoot, 'stale'), 'stale'); await expect(loadNativeLaunch(f.input)).rejects.toThrow('fresh empty');
    await rm(join(f.launch.controlRoot, 'stale'));
    const nested = join(f.input.workspacePath, 'evaluator'); await mkdir(nested);
    await expect(loadNativeLaunch({ ...f.input, protectedPaths: [nested] })).rejects.toThrow('evaluator');
    const alias = join(f.root, 'alias'); await symlink(f.launch.projections[0]!.source, alias);
    f.launch.projections[0]!.source = alias; await f.save(); await expect(loadNativeLaunch(f.input)).rejects.toThrow('real file');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('only one explicitly selected private portable credential ingress is mounted read-only', async () => {
  const f = await launchFixture();
  try {
    const auth = join(f.root, 'non-login-fixture'); await writeFile(auth, 'Unit fixture, never native authentication.', { mode: 0o600 });
    f.launch.credentials = [{ source: auth, target: '/native/home/.daimon-inbound/codex-auth' }]; await f.save();
    expect((await loadNativeLaunch(f.input)).credentials).toHaveLength(1);
    for (const source of [join(f.input.workspacePath, 'auth'), join(f.launch.projections[0]!.source, 'auth'), join(f.launch.workerRoot, 'auth')]) {
      await writeFile(source, 'Unit login-shape fixture', { mode: 0o600 });
      f.launch.credentials[0]!.source = source; await f.save(); await expect(loadNativeLaunch(f.input)).rejects.toThrow('another native mount');
    }
    f.launch.credentials[0]!.source = auth; await f.save();
    await chmod(auth, 0o644); await expect(loadNativeLaunch(f.input)).rejects.toThrow('private read-only'); await chmod(auth, 0o600);
    f.launch.credentials[0]!.target = '/native/workspace/auth'; await f.save(); await expect(loadNativeLaunch(f.input)).rejects.toThrow('ingress');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
