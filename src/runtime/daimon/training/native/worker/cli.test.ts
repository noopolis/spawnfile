import { expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

test('worker CLI reports startup failures as machine-readable nonzero completion', async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  vi.doMock('./worker.js', () => ({ runDaimonNativeWorker: run }));
  const prior = process.argv[1]; const exitCode = process.exitCode;
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    process.argv[1] = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const { nativeWorkerMain } = await import('./cli.js');
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(await nativeWorkerMain([])).toBe(0);
    run.mockRejectedValue(new Error('Unit startup rejection'));
    expect(await nativeWorkerMain([])).toBe(1);
    expect(stderr.mock.calls.some(([value]) => String(value).includes('Unit startup rejection'))).toBe(true);
    run.mockRejectedValue('non-error rejection'); expect(await nativeWorkerMain([])).toBe(1);
    vi.resetModules(); process.argv[1] = '/not-the-worker';
    await import('./cli.js');
  } finally { process.argv[1] = prior!; process.exitCode = exitCode; stderr.mockRestore(); vi.doUnmock('./worker.js'); }
});
