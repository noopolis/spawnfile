import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from './commands.js';
import { cliFixture, fixtureAdapter } from './fixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function storedInvocation() {
  const fixture = await cliFixture(); roots.push(fixture.root);
  fixture.dependencies.adapter = id => fixtureAdapter(id, fixture.observedInstructions, 'pass');
  expect(await main(['evaluate', 'data.yaml', ...fixture.nativeArgs], fixture.io, fixture.dependencies)).toBe(0);
  return fixture;
}

it('keeps the actual replay HTTP server alive past three minutes until caller cancellation', async () => {
  const fixture = await storedInvocation(), controller = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let ready!: (url: string) => void;
  const address = new Promise<string>(resolve => { ready = resolve; });
  let settled = false;
  const running = main(['view', join(fixture.root, 'out')], { ...fixture.io, signal: controller.signal,
    stdout: text => { ready(JSON.parse(text).viewer); } }).then(code => { settled = true; return code; });
  let url: string | undefined;
  try {
    url = await address;
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(settled).toBe(false);
    // Real network and storage, with only the command's clock advanced.
    vi.useRealTimers();
    const response = await fetch(`${url}/api/data`);
    expect(response.status).toBe(200);
    expect((await response.json()).trials).toHaveLength(1);
    expect(fixture.observedInstructions).toHaveLength(1);
  } finally {
    vi.useRealTimers(); controller.abort();
    expect(await running).toBe(130);
  }
  expect(fixture.stderr.join('')).not.toContain('deadline exceeded');
  await expect(fetch(url!)).rejects.toThrow();
});

it('honors an explicit replay deadline and closes its actual listening socket', async () => {
  const fixture = await storedInvocation(), controller = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let ready!: (url: string) => void;
  const address = new Promise<string>(resolve => { ready = resolve; });
  let settled = false;
  const running = main(['view', join(fixture.root, 'out'), '--timeout-ms', '1000'], {
    ...fixture.io, signal: controller.signal, stdout: text => { ready(JSON.parse(text).viewer); },
  }).then(code => { settled = true; return code; });
  try {
    const url = await address;
    await vi.advanceTimersByTimeAsync(999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await running).toBe(2);
    expect(fixture.stderr.join('')).toContain('CLI command deadline exceeded');
    await expect(fetch(url)).rejects.toThrow();
    expect(fixture.observedInstructions).toHaveLength(1);
  } finally { vi.useRealTimers(); controller.abort(); await running; }
});

it.each([['evaluate', 180_000], ['train', 43_200_000]] as const)('installs the implicit %s command deadline', async (command, deadlineMs) => {
  const fixture = await cliFixture(); roots.push(fixture.root);
  const timer = vi.spyOn(globalThis, 'setTimeout'), clear = vi.spyOn(globalThis, 'clearTimeout');
  // Missing runtime arguments reject before cognition, after installing the command deadline.
  expect(await main(command === 'train' ? ['train', '--train', 'data.yaml'] : ['evaluate', 'data.yaml'], fixture.io)).toBe(2);
  expect(timer).toHaveBeenCalledWith(expect.any(Function), deadlineMs);
  expect(clear).toHaveBeenCalledWith(timer.mock.results[0]!.value);
  expect(fixture.observedInstructions).toEqual([]);
});
