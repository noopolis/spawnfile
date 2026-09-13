import { expect, test, vi } from 'vitest';
import { loadDaimonRuntime } from './public.js';

test('optional native package is loaded only through its public runtime contract', async () => {
  vi.doMock('@noopolis/daimon/runtime', () => { throw new Error('not installed'); });
  await expect(loadDaimonRuntime()).rejects.toThrow('Install optional');
  vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig: undefined, createOrganizationRuntimeControlHost: undefined }));
  await expect(loadDaimonRuntime()).rejects.toThrow('lacks');
  vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig: vi.fn(), createOrganizationRuntimeControlHost: undefined }));
  await expect(loadDaimonRuntime()).rejects.toThrow('lacks');
  const parseOrganizationRuntimeConfig = vi.fn(); const createOrganizationRuntimeControlHost = vi.fn();
  vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig, createOrganizationRuntimeControlHost, resolveOrganizationCodexSandboxProjection: undefined }));
  await expect(loadDaimonRuntime()).rejects.toThrow('sandbox projection capability');
  vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig, createOrganizationRuntimeControlHost, resolveOrganizationCodexSandboxProjection: vi.fn() }));
  expect((await loadDaimonRuntime()).createOrganizationRuntimeControlHost).toBe(createOrganizationRuntimeControlHost);
  vi.doUnmock('@noopolis/daimon/runtime');
});
