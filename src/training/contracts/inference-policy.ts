import type { TrainingConfiguration, TrainingModel, TrainingRoute } from './training-config.js';

/** Versions describe maintained invocation policy, not model/account or ambient profile contents. */
const policies: Readonly<Record<TrainingModel['provider'], string>> = Object.freeze({
  'grok-subscription': 'paideia.grok-attested-response.v3',
  'grok-broker': 'paideia.grok-broker-grant-response.v1',
  'claude-subscription': 'paideia.claude-attested-response.v3',
  'codex-subscription': 'paideia.codex-contained-response.v1',
  ollama: 'paideia.ollama-attested-response.v2',
});

/** Preserve route order and include every declared fallback, whether invoked or not. */
export function trainingRoutePolicies(configuration: TrainingConfiguration, route: TrainingRoute, executionIdentity?: string) {
  return [route.model, ...(route.fallbacks ?? [])].map(name => {
    const provider = configuration.models[name]!.provider;
    return { provider, policy: policies[provider], ...executionPolicy(executionIdentity) };
  });
}

/** Pure command identity input; dry-run never constructs a provider or reads host configuration. */
export function trainingInferencePolicies(configuration?: TrainingConfiguration, executionIdentity?: string) {
  const legacy = [{ provider: 'claude-subscription', policy: policies['claude-subscription'], ...executionPolicy(executionIdentity) }];
  return {
    judges: Object.fromEntries(Object.entries(configuration?.judges ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, route]) => [name, trainingRoutePolicies(configuration!, route, executionIdentity)])),
    optimizer: configuration?.comparison ? [] : configuration?.optimizer ? trainingRoutePolicies(configuration, configuration.optimizer, executionIdentity) : legacy,
  };
}

function executionPolicy(identity?: string): { executionIdentity?: string } {
  if (identity === undefined) return {};
  if (typeof identity !== 'string' || !identity.trim() || identity.length > 1024 || [...identity].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('Inference execution identity must be a nonempty immutable identifier of at most 1024 characters');
  }
  return { executionIdentity: identity };
}
