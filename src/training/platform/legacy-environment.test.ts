import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('legacy broker cap reaches the real admission reader and new cap takes precedence', async () => {
  vi.resetModules();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker');
  vi.stubEnv('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', undefined);
  const { assertModelRequestAdmission } = await import('../inference/index.js');
  expect(() => assertModelRequestAdmission('ollama', 'optimizer')).toThrow(/unsupported ollama/u);
  vi.stubEnv('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', '');
  expect(() => assertModelRequestAdmission('grok-broker', 'optimizer')).toThrow(/Unsupported/u);
});
