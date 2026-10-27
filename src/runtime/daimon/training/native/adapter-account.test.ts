import { expect, test } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaimonNativeAdapter } from './adapter.js';
import { dockerFixture, launchFixture } from './test-fixtures.js';
import { acquireNativeAccountLease } from '../services/index.js';

test('native adapter serializes account hosts before turn clocks and keeps refreshed state between trials', async () => {
  const first = await launchFixture(), second = await launchFixture();
  const account = first.launch.projections.find(row => row.role === 'subscription')!;
  second.launch.projections.find(row => row.role === 'subscription')!.source = account.source;
  second.launch.credentials = structuredClone(first.launch.credentials); await second.save();
  const a = dockerFixture(first.launch, first.input.trialId), b = dockerFixture(second.launch, second.input.trialId);
  const owner = await createDaimonNativeAdapter({ docker: a.run, timeoutMs: 100 }).start(first.input);
  try {
    await writeFile(join(account.source, 'auth.json'), 'generation-1', { mode: 0o600 });
    const cancellation = new AbortController();
    const cancelled = createDaimonNativeAdapter({ docker: b.run, timeoutMs: 100 }).start({ ...second.input, signal: cancellation.signal });
    const rejected = expect(cancelled).rejects.toThrow();
    cancellation.abort(); await rejected;
    expect(b.calls).toHaveLength(0);
    await expect(acquireNativeAccountLease(account.source, undefined, 20)).rejects.toThrow('wait bound');
    const next = createDaimonNativeAdapter({ docker: b.run, timeoutMs: 100 }).start(second.input);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(b.calls).toHaveLength(0);
    await writeFile(join(account.source, 'auth.json'), 'generation-2');
    await owner.stop('first complete');
    const successor = await next;
    expect(await readFile(join(account.source, 'auth.json'), 'utf8')).toBe('generation-2');
    expect(b.calls.some(args => args[0] === 'create' && args.some(arg => arg.includes(account.source)))).toBe(true);
    await successor.stop('second complete');
  } finally { await owner.stop('cleanup'); await rm(first.root, { recursive: true, force: true }); await rm(second.root, { recursive: true, force: true }); }
});

test('startup failure releases account admission only after verified container cleanup', async () => {
  const f = await launchFixture();
  const account = f.launch.projections.find(row => row.role === 'subscription')!;
  const docker = dockerFixture(f.launch, f.input.trialId);
  try {
    await expect(createDaimonNativeAdapter({ docker: async (args, options) => {
      if (args[0] === 'start') return { code: 1, stdout: '', stderr: 'start refused' };
      return docker.run(args, options);
    } }).start(f.input)).rejects.toThrow('start failed');
    const available = await acquireNativeAccountLease(account.source, undefined, 0); available();
    const unknown = dockerFixture(f.launch, f.input.trialId); unknown.forgeOwner();
    await expect(createDaimonNativeAdapter({ docker: unknown.run }).start(f.input)).rejects.toThrow();
    await expect(acquireNativeAccountLease(account.source, undefined, 20)).rejects.toThrow('wait bound');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
