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
  vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig, createOrganizationRuntimeControlHost,
    resolveOrganizationCodexSandboxProjection: vi.fn(), parseWakeAcceptanceRequest: undefined }));
  expect((await loadDaimonRuntime()).createOrganizationRuntimeControlHost).toBe(createOrganizationRuntimeControlHost);
  await expect(loadDaimonRuntime('codex', 'transport')).rejects.toThrow('public transport wake parser');
  vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig, createOrganizationRuntimeControlHost,
    resolveOrganizationCodexSandboxProjection: vi.fn(), parseWakeAcceptanceRequest: vi.fn() }));
  expect(typeof (await loadDaimonRuntime('codex', 'transport')).parseWakeAcceptanceRequest).toBe('function');
  const grok = { resolveOrganizationGrokBrokerProjection: vi.fn(), grokBrokerProjectionSha256: vi.fn(), verifyGrokSlotPreflightReceipt: vi.fn() };
  for (const missing of Object.keys(grok)) {
    vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig, createOrganizationRuntimeControlHost, ...grok, [missing]: undefined }));
    await expect(loadDaimonRuntime('grok')).rejects.toThrow('Grok broker projection');
  }
  vi.doMock('@noopolis/daimon/runtime', () => ({ parseOrganizationRuntimeConfig, createOrganizationRuntimeControlHost, ...grok, resolveOrganizationCodexSandboxProjection: undefined }));
  expect((await loadDaimonRuntime('grok')).verifyGrokSlotPreflightReceipt).toBe(grok.verifyGrokSlotPreflightReceipt);
  await expect(loadDaimonRuntime()).rejects.toThrow('sandbox projection capability');
  vi.doUnmock('@noopolis/daimon/runtime');
});
