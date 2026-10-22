import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SubjectStart } from '../../contracts/execution.js';
import type { ProcessOptions, RunningProcess } from '../../platform/process/index.js';
import { codexArguments, combineSignals, createCodexAdapter } from './adapter.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<{ input: SubjectStart; authHome: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'paideia-codex-unit-')); roots.push(root);
  const authHome = path.join(root, 'auth'); await mkdir(authHome); await writeFile(path.join(authHome, 'auth.json'), '{}');
  return { authHome, input: { trialId: 'trial', workspacePath: path.join(root, 'workspace'), runtimeHomePath: path.join(root, 'runtime'),
    instructions: 'candidate instructions', model: 'explicit', onObservation: () => undefined } };
}
function runner(events: unknown[], result: Partial<Awaited<RunningProcess['completion']>> = {}) {
  return (options: ProcessOptions): RunningProcess => ({
    write: async () => undefined, endInput: () => undefined,
    completion: (async () => { for (const event of events) await options.onLine(JSON.stringify(event), new AbortController().signal);
      return { exitCode: 0, stderr: '', cancelled: false, ...result }; })(),
    stop: async (reason) => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test process' }),
  });
}
const completed = [{ type: 'thread.started', thread_id: 'exact-thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
  { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 4 } }];

it('runs and resumes only the native thread while retaining the permission boundary', async () => {
  const { input, authHome } = await fixture();
  const calls: ProcessOptions[] = [];
  const session = await createCodexAdapter({ authHome, model: 'explicit', process: (options) => {
    calls.push(options); return runner(completed)(options);
  } }).start(input);
  expect((await session.run({ id: 'one', text: 'task' })).status).toBe('completed');
  const second = await session.run({ id: 'two', text: 'follow-up' });
  expect(second.usage?.inputTokens).toBe(0);
  expect(calls[1]?.args.slice(-3)).toEqual(['resume', 'exact-thread', '-']);
  expect(calls[0]?.env['OPENAI_API_KEY']).toBeUndefined();
  expect(await session.stop('finished')).toMatchObject({ state: 'acknowledged' });
  await expect(session.run({ id: 'three', text: 'no' })).rejects.toThrow('stopped');
});

it('rejects unsupported tools and absent resume identities', async () => {
  const { input, authHome } = await fixture();
  const adapter = createCodexAdapter({ authHome, process: runner([]) });
  for (const model of [undefined, '', '--bad']) await expect(adapter.start({ ...input, model })).rejects.toThrow('explicit');
  await expect(adapter.start({ ...input, tools: [{ name: 'tool', description: '', parameters: {}, execute: async () => ({}) }] })).rejects.toThrow('mounting');
  const session = await adapter.start(input);
  expect((await session.run({ id: 'one', text: 'task' })).status).toBe('failed');
  await expect(session.run({ id: 'two', text: 'task' })).rejects.toThrow('stopped');
});

it('records protocol failure, nonzero exit and cancellation without success claims', async () => {
  const { input, authHome } = await fixture();
  for (const [events, result, expected] of [
    [[{ type: 'error', message: 'quota' }], {}, 'quota'],
    [[], { exitCode: 2, stderr: 'crashed' }, 'Codex exited'],
    [[], { error: 'observer failure', cancelled: true }, 'observer failure'],
  ] as const) {
    const session = await createCodexAdapter({ authHome, process: runner([...events], result) }).start(input);
    const turn = await session.run({ id: 'one', text: 'task' });
    expect(turn.error).toContain(expected);
    expect(turn.status).not.toBe('completed');
    expect(turn.status).toBe('failed');
    await expect(session.run({ id: 'retry', text: 'task' })).rejects.toThrow('stopped');
  }
});

it('prevents concurrent wakes and stops an active native process', async () => {
  const { input, authHome } = await fixture();
  let finish!: () => void;
  const session = await createCodexAdapter({ authHome, process: () => ({
    write: async () => undefined, endInput: () => undefined,
    completion: new Promise((resolve) => { finish = () => resolve({ exitCode: null, stderr: '', cancelled: true }); }),
    stop: async (reason) => { finish(); return { state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }; },
  }) }).start(input);
  const work = session.run({ id: 'one', text: 'task' });
  await expect(session.run({ id: 'two', text: 'task' })).rejects.toThrow('Concurrent');
  expect((await session.stop('operator')).state).toBe('acknowledged');
  expect((await work).status).toBe('cancelled');
});

it('renders explicit instructions and protected native paths with no ambient config', async () => {
  const { input, authHome } = await fixture();
  const args = codexArguments({ ...input, protectedPaths: ['/private/evaluator'], model: 'model' }, authHome, 'explicit');
  expect(args).toContain('project_doc_max_bytes=0');
  expect(args).toContain('mcp_servers={}');
  expect(args).toContain('developer_instructions="candidate instructions"');
  expect(args.join(' ')).toContain('"/private/evaluator"="deny"');
  expect(args).not.toContain('--last');
  expect(combineSignals()).toBeUndefined();
  const controller = new AbortController(); controller.abort();
  expect(combineSignals(controller.signal)?.aborted).toBe(true);
});
