import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaimonNativeAdapter } from '../index.js';
import { launchFixture, unadmittedFixture } from '../test-fixtures.js';
import { sha256 } from '../receipt/index.js';
import { startOwnedChild } from './lifecycle.js';

vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const http = vi.hoisted(() => vi.fn());
vi.mock('../transport/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../transport/index.js')>(), createNativeHttpClient: () => http,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Real owned processes, deterministic control responses; no model or HTTP acceptance claim.
async function fixture() {
  const f = await launchFixture(); roots.push(f.root);
  f.launch.workspace.target = f.launch.workspace.source;
  for (const row of f.launch.projections) row.target = row.source;
  const config = JSON.parse(await readFile(f.launch.config, 'utf8'));
  config.agents[0].workspacePath = f.launch.workspace.target;
  config.agents[0].runtimeHomePath = f.launch.projections[0]!.target;
  config.agents[0].instructions = f.input.instructions;
  const bytes = JSON.stringify(config); f.launch.configSha256 = sha256(bytes);
  await writeFile(f.launch.config, bytes); await f.save();
  await writeFile(join(f.launch.bootstrap!.root, f.launch.bootstrap!.entrypoint), `
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(join(f.launch.controlRoot, 'child-env.json'))},JSON.stringify({pid:process.pid}));
process.on('SIGTERM',()=>process.exit(0));
console.log(${JSON.stringify(JSON.stringify({ schema: 'paideia.daimon-native.ready.v1', trialId: f.input.trialId,
    configSha256: f.launch.configSha256, agentId: f.launch.agent.id, model: f.launch.agent.model, port: f.launch.host.port }))});
setInterval(()=>{},100);
`);
  const frame = unadmittedFixture(f.input.trialId); frame.configSha256 = f.launch.configSha256;
  http.mockImplementation(async (path: string) => {
    if (path === '/trial/health') return { version: 'noopolis.daimon.organization-runtime-health.v1', state: 'running', agents: [{ agentId: f.launch.agent.id }] };
    if (path === '/v2/activity') return { version: 'noopolis.daimon.organization-runtime-activity.v2', items: [], executions: [] };
    if (path === '/trial/stop') return { state: 'acknowledged', quiescence: 'unknown', containmentVerification: 'parent-container-owner' };
    if (path === '/trial/run') return frame;
    throw new Error('Unexpected fixture request');
  });
  return f;
}

it('derives parent closure for a Codex failure without promoting the worker stop frame', async () => {
  const f = await fixture();
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' } }).start(f.input);
  const result = await session.run({ id: 'task', text: 'Work' });
  expect(result).toMatchObject({ status: 'failed', text: '', usage: null,
    admission: { executionRecords: 0, executionsUsed: 0, tokensUsed: 0 } });
  expect(await session.stop('Infrastructure failure')).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  const { pid } = JSON.parse(await readFile(join(f.launch.controlRoot, 'child-env.json'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

it('keeps the raw Codex stop unknown until the parent verifies shutdown', async () => {
  const f = await fixture();
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  expect(await handle.request('/trial/stop', {})).toMatchObject({ state: 'acknowledged', quiescence: 'unknown',
    containmentVerification: 'parent-container-owner' });
  expect(await handle.stop('Parent verification')).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
});

it('refuses replacement closure when a descendant survives the cleanly exited leader', async () => {
  const f = await fixture();
  const bootstrap = join(f.launch.bootstrap!.root, f.launch.bootstrap!.entrypoint);
  const descendantFile = join(f.root, 'descendant-pid');
  const descendantCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));setInterval(()=>{},100);`;
  await writeFile(bootstrap, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'}).unref();\n${await readFile(bootstrap, 'utf8')}`);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  let descendant = 0;
  await vi.waitFor(async () => { descendant = Number(await readFile(descendantFile, 'utf8')); expect(descendant).toBeGreaterThan(0); });
  const { pid } = JSON.parse(await readFile(join(f.launch.controlRoot, 'child-env.json'), 'utf8'));
  try {
    const signals = vi.spyOn(process, 'kill');
    const receipt = await handle.stop('Leader alone is insufficient');
    expect(receipt).toMatchObject({ state: 'unknown', quiescence: 'unknown', unconfirmed: 'child-running' });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(descendant, 0)).not.toThrow();
    expect(signals.mock.calls).not.toContainEqual([-pid, 'SIGKILL']);
  } finally {
    try { process.kill(descendant, 'SIGKILL'); } catch { /* Already gone under a signal-guard mutation. */ }
  }
});

it('fails closed when process-group disappearance cannot be observed', async () => {
  const f = await fixture();
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 0) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  expect(await handle.stop('Unobservable group')).toMatchObject({ state: 'unknown', quiescence: 'unknown', unconfirmed: 'child-running' });
});

it('waits for a cooperative descendant after leader reap before confirming closure', async () => {
  const f = await fixture();
  const bootstrap = join(f.launch.bootstrap!.root, f.launch.bootstrap!.entrypoint);
  const descendantFile = join(f.root, 'descendant-pid');
  const descendantCode = `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250));require('node:fs').writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));setInterval(()=>{},100);`;
  await writeFile(bootstrap, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'}).unref();\n${await readFile(bootstrap, 'utf8')}`);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  let descendant = 0;
  await vi.waitFor(async () => { descendant = Number(await readFile(descendantFile, 'utf8')); expect(descendant).toBeGreaterThan(0); });
  const { pid } = JSON.parse(await readFile(join(f.launch.controlRoot, 'child-env.json'), 'utf8'));
  try {
    expect(await handle.stop('Drain group')).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  } finally {
    try { process.kill(descendant, 'SIGKILL'); } catch { /* Normally already gone; clean up after a failing assertion. */ }
  }
});
