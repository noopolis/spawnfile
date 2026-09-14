import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as processOwner from '../platform/process/index.js';
import { runDspyOptimization } from './runner.js';
import { simulatedOptions, scriptBridge } from './testSupport.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), 'paideia-home-test-'))); roots.push(root); return root; }
function observeHomes() {
  const homes: string[] = [], original = processOwner.runProcess;
  vi.spyOn(processOwner, 'runProcess').mockImplementation(options => {
    const home = options.env.HOME!; homes.push(home);
    expect(home).toBeTruthy(); expect(home).not.toBe('/ambient-secret-home');
    expect(statSync(home).mode & 0o777).toBe(0o700); expect(readdirSync(home)).toEqual([]);
    return original(options);
  });
  return homes;
}

it('gives actual DSPy a fresh private home per run and cleans it after verified success', async () => {
  vi.stubEnv('HOME', '/ambient-secret-home'); const homes = observeHomes();
  const checkpoint = await directory();
  for (const withCheckpoint of [true, false]) {
    const { options } = simulatedOptions(); options.budget.maxMetricCalls = 1;
    if (withCheckpoint) options.checkpoint = { directory: checkpoint, identity: 'stable', resume: false };
    const result = await runDspyOptimization(options);
    expect(result.provenance.optimizer).toBe('dspy.GEPA');
    const home = homes.at(-1)!;
    if (withCheckpoint) expect(dirname(home)).toBe(checkpoint);
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(new Set(homes).size).toBe(2);
});

it('Python Path.home resolves the supplied home without ambient identity and cleanup follows failed process exit', async () => {
  vi.stubEnv('HOME', '/ambient-secret-home'); const homes = observeHomes();
  const root = await directory(), receipt = join(root, 'home.json');
  const { options } = simulatedOptions();
  options.bridge = { command: resolve('bridges/dspy/.venv/bin/python'), cwd: process.cwd(), timeoutMs: 2000,
    args: ['-c', `import json,pathlib,sys\npathlib.Path(${JSON.stringify(receipt)}).write_text(json.dumps({'home':str(pathlib.Path.home())}))\nsys.exit(3)`] };
  await expect(runDspyOptimization(options)).rejects.toThrow('unsuccessfully (3)');
  expect(JSON.parse(await readFile(receipt, 'utf8')).home).toBe(homes[0]);
  await expect(stat(homes[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleans home on confirmed timeout and launch failure', async () => {
  const homes = observeHomes();
  for (const command of ['stall', 'missing']) {
    const { options } = simulatedOptions();
    options.bridge = command === 'stall' ? { ...scriptBridge('setInterval(()=>{},10)'), timeoutMs: 100 } : { ...options.bridge, command: '/missing-bridge' };
    await expect(runDspyOptimization(options)).rejects.toThrow();
    await expect(stat(homes.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('preserves the owned home and fails when process closure is unknown', async () => {
  let home = '';
  vi.spyOn(processOwner, 'runProcess').mockImplementation(options => {
    home = options.env.HOME!; roots.push(home);
    return { completion: Promise.resolve({ exitCode: 0, stderr: '', cancelled: false }),
      stop: async () => ({ state: 'unknown', scope: 'process-group', quiescence: 'unknown', remoteWork: 'unknown', reason: 'unconfirmed', detail: 'fixture retains work' }),
      write: async () => undefined, endInput: () => undefined };
  });
  await expect(runDspyOptimization(simulatedOptions().options)).rejects.toMatchObject({ message: 'DSPy process closure is unconfirmed',
    evidence: { stop: { quiescence: 'unknown' } } });
  expect((await stat(home)).isDirectory()).toBe(true);
});
