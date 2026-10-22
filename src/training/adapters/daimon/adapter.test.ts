import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { FixtureTool, Observation, SubjectStart } from '../../contracts/execution.js';
import { createDaimonAdapter } from './adapter.js';
import type { DaimonModule, NativeHandle, NativeTool } from './public.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<{ input: SubjectStart; authHome: string; events: Observation[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'paideia-daimon-unit-')); roots.push(root);
  const authHome = path.join(root, 'auth'); await mkdir(authHome); await writeFile(path.join(authHome, 'auth.json'), '{}');
  const events: Observation[] = [];
  return { authHome, events, input: { trialId: 'trial', workspacePath: path.join(root, 'workspace'), runtimeHomePath: path.join(root, 'runtime'),
    instructions: 'candidate instructions', model: 'explicit', onObservation: (event) => { events.push(event); } } };
}
interface FacadeOptions {
  run?: (tools: NativeTool[], options: Record<string, unknown>) => Promise<string>;
  stop?: () => Promise<void>;
  state?: string;
}
function facade(options: FacadeOptions = {}): DaimonModule {
  let cli: Record<string, unknown> = {};
  return {
    createCliSessionFactory(input) { cli = input; return {}; },
    renderCodexArgs: () => ['project_doc_max_bytes=0'],
    PiHarnessAdapter: class {
      static capabilities = { causalRunId: true };
      constructor(private settings: Record<string, unknown>) {}
      async startAgent(): Promise<NativeHandle> {
        let state = 'idle';
        return { wake: async () => ({ text: await options.run?.(this.settings['productionTools'] as NativeTool[], cli) ?? 'done' }),
          stop: async () => { await options.stop?.(); state = 'stopped'; },
          status: () => ({ state: options.state ?? state }) };
      }
    },
  };
}
const successTool: FixtureTool = { name: 'file', description: 'file a fixture', parameters: { type: 'object' }, execute: async () => ({ filed: true }) };

it('maps explicit instructions and journals real fixture calls while keeping built-in coverage partial', async () => {
  const { input, authHome, events } = await fixture();
  const actualAuth = await realpath(authHome);
  const hidden = path.join(path.dirname(authHome), 'hidden'); await mkdir(hidden);
  const actualHidden = await realpath(hidden);
  const native = facade({ run: async (tools, options) => {
    expect(options['identityPrompt']).toBe(input.instructions);
    expect(options['codexProjectDocMaxBytes']).toBe(0);
    expect(options['engineHomePath']).toBe(actualAuth);
    expect(options['codexSandboxProtectedPaths']).toEqual([actualAuth, actualHidden]);
    await tools[0]!.execute('native-call', { story: 'one' });
    await (options['onTurnUsage'] as (usage: unknown) => Promise<void>)({ input: 10, output: 2, cacheRead: 5 });
    return 'filed';
  } });
  const session = await createDaimonAdapter({ authHome, load: async () => native }).start({ ...input, protectedPaths: [hidden], tools: [successTool] });
  const result = await session.run({ id: 'wake', text: 'task' });
  expect(result).toMatchObject({ status: 'completed', text: 'filed', usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: null } });
  expect(result.coverage[0]?.completeness).toBe('partial');
  expect(events[0]).toMatchObject({ type: 'tool.dispatch', callId: 'native-call', wakeId: 'wake' });
  expect(events[1]).toMatchObject({ type: 'tool.complete', success: true, causalParents: [events[0]!.id] });
  const stopped = await session.stop('complete');
  expect(stopped).toMatchObject({ state: 'acknowledged', quiescence: 'unknown' });
  await expect(session.run({ id: 'next', text: 'task' })).rejects.toThrow('cross-wake');
});

it('does not claim successful output after native errors, tool errors or empty results', async () => {
  const { input, authHome, events } = await fixture();
  const failing: FixtureTool = { ...successTool, execute: async () => { throw new Error('rejected'); } };
  const session = await createDaimonAdapter({ authHome, load: async () => facade({ run: async (tools) => {
    await tools[0]!.execute('call', {}); return 'unreachable';
  } }) }).start({ ...input, tools: [failing] });
  expect((await session.run({ id: 'wake', text: 'task' })).error).toBe('rejected');
  expect(events[1]?.success).toBe(false);
  const empty = await createDaimonAdapter({ authHome, load: async () => facade({ run: async () => '' }) }).start(input);
  expect((await empty.run({ id: 'wake', text: 'task' })).status).toBe('failed');
});

it('fails preflight when older native releases silently ignore isolated instructions', async () => {
  const { input, authHome } = await fixture();
  const native = facade(); native.renderCodexArgs = () => [];
  for (const model of [undefined, '', '--bad']) await expect(createDaimonAdapter({ authHome, load: async () => native }).start({ ...input, model })).rejects.toThrow('explicit');
  await expect(createDaimonAdapter({ authHome, load: async () => native }).start(input)).rejects.toThrow('ambient');
  native.PiHarnessAdapter.capabilities = undefined;
  await expect(createDaimonAdapter({ authHome, load: async () => native }).start(input)).rejects.toThrow('causal run context');
});

it('retains uncertain native stop acknowledgements and refuses work after stopping', async () => {
  const { input, authHome } = await fixture();
  for (const options of [{ stop: async () => { throw new Error('still active'); } }, { state: 'running' }]) {
    const session = await createDaimonAdapter({ authHome, load: async () => facade(options) }).start(input);
    expect((await session.stop('operator')).state).toBe('unknown');
    await expect(session.run({ id: 'wake', text: 'task' })).rejects.toThrow('stopped');
  }
});

it('honors cancellation before waking and never executes fixture work after an aborted dispatch', async () => {
  const { input, authHome } = await fixture();
  const never = vi.fn(async () => 'must not run');
  const session = await createDaimonAdapter({ authHome, load: async () => facade({ run: never }) }).start(input);
  expect((await session.run({ id: 'wake', text: 'task' }, AbortSignal.abort())).status).toBe('cancelled');
  expect(never).not.toHaveBeenCalled();
  const fixtureTool = vi.fn(successTool.execute);
  const during = await createDaimonAdapter({ authHome, load: async () => facade({ run: async (tools) => {
    await tools[0]!.execute('call', {}, AbortSignal.abort()); return 'unreachable';
  } }) }).start({ ...input, tools: [{ ...successTool, execute: fixtureTool }] });
  expect((await during.run({ id: 'wake', text: 'task' })).status).toBe('failed');
  expect(fixtureTool).not.toHaveBeenCalled();
});

it('propagates callback failures despite a native runtime swallowing telemetry errors', async () => {
  const { input, authHome } = await fixture();
  const session = await createDaimonAdapter({ authHome, load: async () => facade({ run: async (_tools, options) => {
    try { await (options['onTurnUsage'] as (value: unknown) => Promise<void>)({}); } catch { /* Mirrors native advisory telemetry. */ }
    return 'looks done';
  } }) }).start({ ...input, onObservation: () => { throw new Error('capture unavailable'); } });
  const result = await session.run({ id: 'wake', text: 'task' });
  expect(result.status).not.toBe('completed');
  expect(result.error).toBe('capture unavailable');
  expect(result.status).toBe('failed');
});

it('bounds native wakes and stop acknowledgements even when the runtime ignores cancellation', async () => {
  const { input, authHome } = await fixture();
  const never = (): Promise<never> => new Promise(() => undefined);
  const session = await createDaimonAdapter({ authHome, timeoutMs: 10, stopTimeoutMs: 10,
    load: async () => facade({ run: never, stop: never }),
  }).start(input);
  const result = await session.run({ id: 'wake', text: 'task' });
  expect(result.status).toBe('failed');
  expect(result.stop).toMatchObject({ state: 'unknown', quiescence: 'unknown' });
  expect(result.stop?.detail).toContain('deadline');
  await expect(createDaimonAdapter({ authHome, stopTimeoutMs: 0 }).start(input)).rejects.toThrow('positive');
});
