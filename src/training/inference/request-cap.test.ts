import { afterEach, expect, it, vi } from 'vitest';
import { assertModelRequestAdmission } from './request-cap.js';

afterEach(() => vi.unstubAllEnvs());
it('requires broker admission only in explicitly capped containers and rejects unknown policies', () => {
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', undefined);
  expect(() => assertModelRequestAdmission('ollama', 'optimizer')).not.toThrow();
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker');
  expect(() => assertModelRequestAdmission('grok-broker', 'judge')).not.toThrow();
  expect(() => assertModelRequestAdmission('ollama', 'optimizer')).toThrow(/unsupported ollama/);
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'invalid');
  expect(() => assertModelRequestAdmission('grok-broker', 'judge')).toThrow(/Unsupported/);
});
