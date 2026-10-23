import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('reads both environment spellings with current values winning even when empty and warns once per process', async () => {
  vi.resetModules();
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const { trainingEnvironment } = await import('./trainingLegacyEnvironment.js');
  expect(trainingEnvironment('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', {})).toBeUndefined();
  expect(stderr).not.toHaveBeenCalled();
  expect(trainingEnvironment('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', { PAIDEIA_MODEL_REQUEST_CAP: 'broker' })).toBe('broker');
  expect(trainingEnvironment('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', { PAIDEIA_MODEL_REQUEST_CAP: 'legacy', SPAWNFILE_TRAINING_MODEL_REQUEST_CAP: '' })).toBe('');
  expect(trainingEnvironment('SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE', { PAIDEIA_TYPESAFE_SECRET_FILE: '/secret' })).toBe('/secret');
  expect(stderr).toHaveBeenCalledTimes(1);
  expect(stderr.mock.calls[0]![0]).toMatch(/Deprecated.*SPAWNFILE_TRAINING_/u);
});

it('normalizes injected child environments without legacy names and preserves unrelated values', async () => {
  vi.resetModules();
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const { normalizedTrainingEnvironment, trainingEnvironment } = await import('./trainingLegacyEnvironment.js');
  const source = { PATH: '/bin', PAIDEIA_MODEL_REQUEST_CAP: 'broker', PAIDEIA_TYPESAFE_SECRET_FILE: '/old',
    SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE: '/current', PAIDEIA_TRAINING_SLOTS_FILE: '/slots', PAIDEIA_UNUSED: undefined };
  expect(normalizedTrainingEnvironment(source)).toEqual({ PATH: '/bin', SPAWNFILE_TRAINING_MODEL_REQUEST_CAP: 'broker',
    SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE: '/current', SPAWNFILE_TRAINING_SLOTS_FILE: '/slots' });
  expect(trainingEnvironment('SPAWNFILE_TRAINING_SLOTS_FILE', source)).toBe('/slots');
  expect(source.PAIDEIA_MODEL_REQUEST_CAP).toBe('broker');
  expect(stderr).toHaveBeenCalledTimes(1);
});

it('reads real process environment through the same precedence and warning policy', async () => {
  vi.resetModules();
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker');
  vi.stubEnv('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', undefined);
  const { trainingEnvironment, normalizedTrainingEnvironment } = await import('./trainingLegacyEnvironment.js');
  expect(trainingEnvironment('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP')).toBe('broker');
  vi.stubEnv('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', 'current');
  expect(trainingEnvironment('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP')).toBe('current');
  expect(normalizedTrainingEnvironment().SPAWNFILE_TRAINING_MODEL_REQUEST_CAP).toBe('current');
  expect(normalizedTrainingEnvironment()).not.toHaveProperty('PAIDEIA_MODEL_REQUEST_CAP');
  expect(stderr).toHaveBeenCalledTimes(1);
});
