import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { GrokGrantRefusal, grokGrantRefusalCodes, type GrokClientConfigInput, type GrokGrantRefusalCode, type GrokInferenceGrant,
  type GrokInferenceGrantAuthority } from '../../../contracts/inference-grants.js';
import { daimonGrokInferenceClientPin as PIN } from './pins.js';

/** Structural slice of `@noopolis/daimon/runtime` this binding uses. */
export interface DaimonGrantModule {
  EngineBrokerControlClient: new (socketPath: string) => {
    requestInferenceGrant(request: { model: string; reasoningEffort: string; purpose: string }): Promise<GrokInferenceGrant>;
    releaseInferenceGrant(grantId: string): Promise<boolean>;
  };
  EngineBrokerInferenceGrantRefused: new (...args: never[]) => Error & { code: string };
  renderGrokInferenceClientConfig(input: GrokClientConfigInput): string;
  GROK_INFERENCE_CLIENT_MODEL_ID: string;
  GROK_INFERENCE_GRANT_ENV: string;
  GROK_INFERENCE_PROXY_BASE_URL: string;
  GROK_ENGINE_BROKER: { inferenceGrants: { maxLiveGrants: number; failureCodes: readonly string[]; client: { modelId: string; envKey: string; configSha256: unknown } } };
}

export const grokBrokerControlSocketEnv = 'PAIDEIA_GROK_BROKER_CONTROL_SOCKET';
export const grokGrantHomeRootEnv = 'PAIDEIA_GROK_GRANT_HOME_ROOT';

const loadRuntime = async (): Promise<unknown> => {
  const packageName = '@noopolis/daimon/runtime';
  return import(packageName);
};

/**
 * Daimon-backed grant authority over the control socket the training container
 * supplies. Every precondition failure throws; nothing falls back to a desktop login.
 */
export async function loadDaimonGrokGrantAuthority(socketPath: string | undefined, load: () => Promise<unknown> = loadRuntime): Promise<GrokInferenceGrantAuthority> {
  if (socketPath === undefined || !path.isAbsolute(socketPath)) throw new Error(`${grokBrokerControlSocketEnv} must name the broker control socket`);
  const socket = await lstat(socketPath).catch(() => undefined);
  if (socket === undefined || !socket.isSocket()) throw new Error('Grok broker control socket is unavailable');
  let daimon: DaimonGrantModule;
  try { daimon = await load() as DaimonGrantModule; }
  catch (error) { throw new Error('Install optional @noopolis/daimon with its public /runtime export for broker-grant inference', { cause: error }); }
  const grants = daimon.GROK_ENGINE_BROKER?.inferenceGrants;
  if (typeof daimon.EngineBrokerControlClient !== 'function' || typeof daimon.EngineBrokerInferenceGrantRefused !== 'function' ||
    typeof daimon.renderGrokInferenceClientConfig !== 'function' || grants === undefined) throw new Error('Installed Daimon lacks evaluator inference grants');
  if (daimon.GROK_INFERENCE_CLIENT_MODEL_ID !== PIN.modelId || daimon.GROK_INFERENCE_GRANT_ENV !== PIN.envKey || daimon.GROK_INFERENCE_PROXY_BASE_URL !== PIN.proxyBaseUrl ||
    grants.maxLiveGrants !== PIN.maxLiveGrants || !isDeepStrictEqual([...grants.failureCodes], PIN.failureCodes) || grants.client.modelId !== PIN.modelId ||
    grants.client.envKey !== PIN.envKey || !isDeepStrictEqual(grants.client.configSha256, PIN.configSha256)) {
    throw new Error('Installed Daimon inference client contract differs from the Paideia pin');
  }
  const client = new daimon.EngineBrokerControlClient(socketPath);
  const refusal = (error: unknown): unknown => error instanceof daimon.EngineBrokerInferenceGrantRefused && (grokGrantRefusalCodes as readonly string[]).includes(error.code)
    ? new GrokGrantRefusal(error.code as GrokGrantRefusalCode) : error;
  return Object.freeze({
    clientModelId: PIN.modelId, envKey: PIN.envKey, maxLiveGrants: PIN.maxLiveGrants,
    request: input => client.requestInferenceGrant(input).catch((error: unknown) => { throw refusal(error); }),
    release: grantId => client.releaseInferenceGrant(grantId).catch((error: unknown) => { throw refusal(error); }),
    renderClientConfig: input => daimon.renderGrokInferenceClientConfig(input),
    pinnedClientConfigSha256: (model, reasoningEffort) => (PIN.configSha256 as Partial<Record<string, Partial<Record<string, string>>>>)[model]?.[reasoningEffort],
  } satisfies GrokInferenceGrantAuthority);
}
