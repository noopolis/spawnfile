import { expect, test } from 'vitest';
import { chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configFixture, launchFixture } from '../test-fixtures.js';
import { grokConfigFor, grokLaunchFrom } from '../grok-fixtures.js';
import { sha256 } from '../receipt/index.js';
import { assertNativeProfile, parseWorkerArguments, verifyWorkerPaths } from './profile.js';
import type { NativeConfig } from './types.js';

test('native profile preserves the selected compiler identity, tools and memory without project constants', async () => {
  const f = await launchFixture();
  try {
    const config = JSON.parse(await readFile(f.launch.config, 'utf8')) as NativeConfig;
    const before = JSON.stringify(config); assertNativeProfile(config, f.launch); expect(JSON.stringify(config)).toBe(before);
    const cases: ((value: NativeConfig) => void)[] = [
      value => { value.version = 'v1'; }, value => { value.agents.push(value.agents[0]!); }, value => { value.agents[0]!.id = 'other'; },
      value => { value.agents[0]!.engine.kind = 'other'; }, value => { value.agents[0]!.engine.model = 'other'; },
      value => { delete value.agents[0]!.engine.codexSandbox; }, value => { value.agents[0]!.engine.codexSandbox!.networkAccess = true; },
      value => { value.agents[0]!.engine.codexSandbox!.mode = 'unsafe'; }, value => { value.agents[0]!.engine.codexSandbox!.webSearch = 'enabled'; },
      value => { delete value.agents[0]!.attention; }, value => { value.agents[0]!.schedule = { kind: 'every' }; },
      value => { value.host.port++; }, value => { value.host.bindHost = '0.0.0.0'; },
      value => { value.agents[0]!.runtimeHomePath = '/other'; }, value => { value.agents[0]!.workspacePath = '/other'; },
      value => { value.agents[0]!.memory!.runtimeHomePath = '/other'; }, value => { value.agents[0]!.attention!.maxTokens = 1; },
    ];
    for (const change of cases) { const modified = structuredClone(config); change(modified); expect(() => assertNativeProfile(modified, f.launch)).toThrow(); }
    delete config.agents[0]!.memory; assertNativeProfile(config, f.launch);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('raw trailing newlines survive while only the declared full compiler rendering is accepted', async () => {
  const f = await launchFixture();
  try {
    const config = configFixture(f.root);
    const raw = 'Compiler-owned identity\n';
    const rendered = '# soul\n\nLocked identity\n\n# system\n\n' + raw.trim();
    await writeFile(join(f.input.workspacePath, 'AGENTS.md'), raw);
    config.agents[0]!.instructions = rendered;
    f.launch.instructions = { relativePath: 'AGENTS.md', sha256: sha256(raw), rendering: {
      kind: 'trim-surround', prefix: '# soul\n\nLocked identity\n\n# system\n\n', suffix: '', nativeSha256: sha256(rendered) } };
    const options = { launch: f.launch.receiptFile, config: f.launch.config, configSha256: f.launch.configSha256,
      controlRoot: f.launch.controlRoot, tokenFile: f.launch.tokenFile, evidence: join(f.launch.controlRoot, 'evidence'),
      trialId: 'unit', timeoutMs: 1000, scheduleOverride: 'disabled' as const };
    await verifyWorkerPaths(config, options, f.launch);
    expect(await readFile(join(f.input.workspacePath, 'AGENTS.md'), 'utf8')).toBe(raw);
    f.launch.instructions.rendering.nativeSha256 = 'f'.repeat(64);
    await expect(verifyWorkerPaths(config, options, f.launch)).rejects.toThrow('absent');
    f.launch.instructions.rendering.nativeSha256 = sha256(rendered);
    config.agents[0]!.instructions = rendered + '\nInjected instruction';
    await expect(verifyWorkerPaths(config, options, f.launch)).rejects.toThrow('absent');
    config.agents[0]!.instructions = rendered;
    await writeFile(join(f.input.workspacePath, 'AGENTS.md'), raw.trim());
    await expect(verifyWorkerPaths(config, options, f.launch)).rejects.toThrow('absent');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('worker arguments and physical files require bounded private exact candidate inputs', async () => {
  const f = await launchFixture();
  try {
    const config = configFixture(f.root);
    const args = ['--launch', f.launch.receiptFile, '--config', f.launch.config, '--config-sha256', f.launch.configSha256,
      '--control-root', f.launch.controlRoot, '--token-file', f.launch.tokenFile, '--evidence', join(f.launch.controlRoot, 'evidence'),
      '--trial-id', 'unit', '--timeout-ms', '1000', '--schedule-override', 'disabled'];
    const options = parseWorkerArguments(args); await verifyWorkerPaths(config, options, f.launch);
    for (const invalid of [[], args.slice(1), [...args, '--unknown', 'x'], [...args, '--trial-id', 'x'],
      ...[['1000', 'NaN'], ['1000', '99'], ['disabled', 'enabled'], [f.launch.configSha256, 'bad'], ['unit', 'bad id'],
        [f.launch.config, 'relative'], [join(f.launch.controlRoot, 'evidence'), f.launch.controlRoot],
        [join(f.launch.controlRoot, 'evidence'), '/elsewhere']].map(([from, to]) => args.map(value => value === from ? to! : value)),
    ]) expect(() => parseWorkerArguments(invalid)).toThrow();
    const alias = join(f.root, 'alias'); await symlink(f.launch.config, alias);
    await expect(verifyWorkerPaths(config, { ...options, config: alias }, f.launch)).rejects.toThrow('symlinks');
    await expect(verifyWorkerPaths(config, { ...options, config: join(f.input.workspacePath, 'AGENTS.md') }, f.launch)).rejects.toThrow('outside');
    await expect(verifyWorkerPaths(config, { ...options, controlRoot: f.input.workspacePath }, f.launch)).rejects.toThrow('separate');
    await chmod(f.launch.controlRoot, 0o755); await expect(verifyWorkerPaths(config, options, f.launch)).rejects.toThrow('private real'); await chmod(f.launch.controlRoot, 0o700);
    await chmod(f.launch.tokenFile, 0o644); await expect(verifyWorkerPaths(config, options, f.launch)).rejects.toThrow('token file'); await chmod(f.launch.tokenFile, 0o600);
    config.agents[0]!.instructions = 'different envelope'; await expect(verifyWorkerPaths(config, options, f.launch)).rejects.toThrow('absent');
    await writeFile(join(f.input.workspacePath, 'AGENTS.md'), ''); await expect(verifyWorkerPaths(config, options, f.launch)).rejects.toThrow('absent');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Grok profile requires the declared broker model and effort without a Codex sandbox', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const config = grokConfigFor(JSON.parse(await readFile(f.launch.config, 'utf8')) as NativeConfig);
    assertNativeProfile(config, launch);
    const cases: [(value: NativeConfig) => void, string][] = [
      [value => { value.agents[0]!.engine.kind = 'codex'; }, 'Grok model'],
      [value => { value.agents[0]!.engine.model = 'grok-4.5'; }, 'Grok model'],
      [value => { value.agents[0]!.engine.reasoningEffort = 'high'; }, 'Grok model'],
      [value => { value.agents[0]!.engine.codexSandbox = { mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' }; }, 'Codex sandbox'],
    ];
    for (const [change, message] of cases) { const modified = structuredClone(config); change(modified); expect(() => assertNativeProfile(modified, launch)).toThrow(message); }
    expect(() => assertNativeProfile(config, { ...launch, broker: { ...launch.broker, limits: { ...launch.broker.limits, maxTokens: 2_000_000 } } })).toThrow('wake ceiling');
    expect(() => assertNativeProfile(grokConfigFor(configFixture()), f.launch.schema === 'paideia.daimon-native.launch.v2' ? { ...launch, agent: { id: launch.agent.id, engine: 'codex', model: 'grok-4.6' } } as never : launch)).toThrow('Codex');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
