import { expect, it } from 'vitest';
import { trainingJudgeVersions, validateTrainingConfiguration } from './index.js';
const config = { models: { small: { provider: 'ollama', model: 'qwen3:4b', think: false, keep_alive_seconds: 300, max_output_tokens: 256, context_window: 8192 } },
  judges: { narrow: { model: 'small', protocol: 'evidence-ids', timeout_ms: 10000 } },
  optimizer: { model: 'small', proposal: { strategy: 'refine', min_change: 0.1, max_attempts: 2, history_entries: 20, history_bytes: 65536 } } };
it('preserves explicit native controls, judge protocol and bounded proposal policy', () => {
  expect(validateTrainingConfiguration(config)).toEqual(config);
  expect(validateTrainingConfiguration({ ...config, judges: { narrow: { model: 'small', protocol: 'citations', citation_repairs: 1 } },
    optimizer: { model: 'small', proposal: {} } })).toBeDefined();
  const minimal = { models: { small: { provider: 'ollama', model: 'qwen3:4b', keep_alive_seconds: 0 } } };
  expect(validateTrainingConfiguration(minimal)).toEqual(minimal);
});
it('rejects unsupported providers and invalid completion controls', () => {
  for (const provider of ['claude-subscription', 'grok-subscription']) for (const field of ['think', 'keep_alive_seconds', 'max_output_tokens', 'context_window']) {
    expect(() => validateTrainingConfiguration({ models: { small: { provider, model: 'x', [field]: 1 } } })).toThrow('only supported');
  }
  for (const patch of [{ context_window: 0 }, { context_window: 1048577 }, { think: 'false' }, { keep_alive_seconds: -1 }, { keep_alive_seconds: 1.5 }, { keep_alive_seconds: 86401 },
    { max_output_tokens: 0 }, { max_output_tokens: 131073 }]) expect(() => validateTrainingConfiguration({ ...config,
    models: { small: { ...config.models.small, ...patch } } })).toThrow();
});
it('rejects incompatible judge protocols and invalid proposal fields', () => {
  for (const patch of [{ protocol: 'other' }, { citation_repairs: 1 }, { proposal: {} }]) expect(() => validateTrainingConfiguration({ ...config,
    judges: { narrow: { ...config.judges.narrow, ...patch } } })).toThrow();
  for (const proposal of [{ strategy: 'other' }, { min_change: -0.1 }, { min_change: 1.1 }, { min_change: NaN },
    { max_attempts: 0 }, { max_attempts: 6 }, { history_entries: 101 }, { history_bytes: 1023 }, { history_bytes: 262145 }, { extra: true }]) {
    expect(() => validateTrainingConfiguration({ ...config, optimizer: { model: 'small', proposal } })).toThrow();
  }
});
it('invalidates judge identities on native controls or protocol changes', () => {
  const version = (value: unknown) => trainingJudgeVersions(validateTrainingConfiguration(value)).narrow!.version;
  const original = version(config);
  for (const patch of [{ context_window: 16384 }, { think: true }, { max_output_tokens: 512 }, { keep_alive_seconds: 600 }]) {
    expect(version({ ...config, models: { small: { ...config.models.small, ...patch } } })).not.toBe(original);
  }
  expect(version({ ...config, judges: { narrow: { ...config.judges.narrow, protocol: 'citations' } } })).not.toBe(original);
});
