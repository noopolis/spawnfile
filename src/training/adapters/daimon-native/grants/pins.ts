import { grokGrantEnvKey, type GrokGrantModel, type GrokGrantReasoningEffort } from '../../../contracts/inference-grants.js';

/**
 * Paideia's pin of Daimon's evaluator inference client contract
 * (`GROK_ENGINE_BROKER.inferenceGrants` in runtime-contract-manifest v4, Grok CLI 1.0.34).
 * These inference-only bytes are unchanged by the clocked subject worker config.
 * Independent of the installed Daimon so drift in either side fails closed.
 */
export const daimonGrokInferenceClientPin = Object.freeze({
  modelId: 'daimon-inference-grok',
  envKey: grokGrantEnvKey,
  proxyBaseUrl: 'http://127.0.0.1:43123/v1',
  maxLiveGrants: 8,
  failureCodes: ['auth_stale', 'grant_limit', 'invalid_request', 'unavailable'],
  configSha256: {
    'grok-4.6': { low: '79314d039f787e4ebfec7dacf57adc969086b948f564dec008f0ed6367e6062f', medium: '6f538de0547c0c4e6a3f04ae08595ceadadabb06b75f6b6ee4c428744bb95cd8', high: '5652656effa82f0c4f09cf8226b16e6140332a5a358b571194bb5563312367ac' },
    'grok-4.5': { low: 'a07f7436f1268bb399ec233c65d3b3d8fb99a11a1f175f8da1ca133c9367bc74', medium: '1f4c0d4dad1f3b09419b5739db6423a09e0049abc091594c64123a75dd53dfb9', high: 'ffbc33728b821e9854fbc7c93601e599225da421ecfd6ebf10d314afcc28d6f2' },
    'grok-build': { low: 'ca15c6a562a008227d39c51d3a3a83715663089b3784e8b46debb1fb67b3c4a1', medium: '01783fb6beadcf6f8486fff0836820ad43fab5662b812a907fe9cfdb83e9804d', high: '98d16f2b7d12f4eb540d625c853e51d227933e204923e43e8b9b4176f10aca2c' },
  } satisfies Record<GrokGrantModel, Record<GrokGrantReasoningEffort, string>>,
});
