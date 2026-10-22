import { expect, test } from 'vitest';
import { DAIMON_GROK_ENGINE_BROKER } from '../../../index.js';
import { daimonGrokInferenceClientPin as pin } from './pins.js';

test('training grant pins agree with the vendored runtime manifest without installing Daimon', () => {
  const grants = DAIMON_GROK_ENGINE_BROKER.inferenceGrants;
  expect(pin.modelId).toBe(grants.client.modelId);
  expect(pin.envKey).toBe(grants.client.envKey);
  expect(pin.maxLiveGrants).toBe(grants.maxLiveGrants);
  expect(pin.failureCodes).toEqual(grants.failureCodes);
  expect(pin.configSha256).toEqual(grants.client.configSha256);
});
