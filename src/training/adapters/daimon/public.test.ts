import { afterEach, expect, it, vi } from 'vitest';
import { loadDaimon } from './public.js';

afterEach(() => { vi.doUnmock('@noopolis/daimon/pi'); vi.resetModules(); });

it('rejects a missing optional runtime without making it a core dependency', async () => {
  vi.doMock('@noopolis/daimon/pi', () => { throw new Error('missing module'); });
  await expect(loadDaimon()).rejects.toThrow('optional @noopolis/daimon');
});

it('requires the complete public facade and accepts its documented native exports', async () => {
  vi.doMock('@noopolis/daimon/pi', () => ({ PiHarnessAdapter: class {}, createCliSessionFactory: () => ({}), renderCodexArgs: undefined }));
  await expect(loadDaimon()).rejects.toThrow('public Pi/CLI');
  vi.doMock('@noopolis/daimon/pi', () => ({ PiHarnessAdapter: class {}, createCliSessionFactory: () => ({}), renderCodexArgs: () => [] }));
  const loaded = await loadDaimon();
  expect(typeof loaded.PiHarnessAdapter).toBe('function');
});
