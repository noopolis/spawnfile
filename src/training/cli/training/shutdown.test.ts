import * as inferenceFactory from './inference.js';
import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { cliFixture, fixtureAdapter } from '../fixture.js';
import { main } from '../commands.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function spyClose() {
  const closes = vi.fn(async () => undefined);
  const factory = inferenceFactory.createTrainingInference;
  vi.spyOn(inferenceFactory, 'createTrainingInference').mockImplementation((...args) => {
    const configured = factory(...args);
    return { ...configured, get inference() { return configured.inference; }, close: async () => { await configured.close(); await closes(); } };
  });
  return closes;
}

it('closes training inference (releasing broker grants) after completion, failure and interruption', async () => {
  const f = await cliFixture(); roots.push(f.root);
  const closes = spyClose();
  expect(typeof await main(['evaluate', 'data.yaml', ...f.nativeArgs], f.io, f.dependencies)).toBe('number');
  expect(f.stdout.join('')).toContain('"status":"completed"');
  expect(closes).toHaveBeenCalledTimes(1);

  const failing = { ...f.dependencies, adapter: () => { const adapter = fixtureAdapter('codex', []); return { ...adapter, start: async () => { throw new Error('native start failed'); } }; } };
  const failArgs = ['evaluate', 'data.yaml', ...f.nativeArgs]; failArgs[failArgs.indexOf('--out') + 1] = 'out-failed';
  await main(failArgs, f.io, failing).catch(() => undefined);
  expect(closes).toHaveBeenCalledTimes(2);

  // SIGINT/SIGTERM: launch aborts the command signal mid-run, after inference was constructed.
  const controller = new AbortController();
  const interrupted = { ...f.dependencies, adapter: () => { const adapter = fixtureAdapter('codex', []);
    return { ...adapter, start: async (input: Parameters<typeof adapter.start>[0]) => { controller.abort(); return adapter.start(input); } }; } };
  const abortArgs = ['evaluate', 'data.yaml', ...f.nativeArgs]; abortArgs[abortArgs.indexOf('--out') + 1] = 'out-aborted';
  const interruptedCode = await main(abortArgs, { ...f.io, signal: controller.signal }, interrupted).catch(() => 'threw');
  expect(interruptedCode).not.toBe(0);
  expect(closes).toHaveBeenCalledTimes(3);
});
