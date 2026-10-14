import { trainingRoutePolicies, trainingInferencePolicies } from '../../contracts/inference-policy.js';
import type { JudgeRoute } from '../../contracts/evaluation.js';
import { createHash } from 'node:crypto';
import type { InferenceProvider } from '../../contracts/index.js';
import type { TrainingModel, TrainingRoute } from '../../contracts/training-config.js';
import { assertModelRequestAdmission, createClaudeInference, createCodexInference, createGrokBrokerInference, createGrokInference, createOllamaInference, createRoutedInference, GrokGrantPool } from '../../inference/index.js';
import { grokBrokerControlSocketEnv, grokGrantHomeRootEnv, loadDaimonGrokGrantAuthority } from '../../adapters/daimon-native/index.js';
import { createJudgeCache } from '../../evaluation/index.js';
import { judgeVersions } from './configuration.js';
import type { CliArguments } from '../arguments.js';
import type { CliDependencies } from '../types.js';

/** Construct only after dry-run and schema preflight have finished. */
export function createTrainingInference(args: CliArguments, dependencies: CliDependencies, timeoutMs: number,
  judges: Record<string, string>, repairs: Record<string, 0 | 1>) {
  const config = args.training;
  const executionIdentity = dependencies.spawnfile?.inferenceExecutionIdentity;
  trainingInferencePolicies(config, executionIdentity);
  // Validate every reachable route before constructing even the first provider.
  const admit = (policy: TrainingRoute | undefined, purpose: string) => {
    if (!policy) return assertModelRequestAdmission('claude-subscription', `${purpose} legacy default`);
    for (const name of [policy.model, ...(policy.fallbacks ?? [])]) {
      assertModelRequestAdmission(config!.models[name]!.provider, `${purpose} model ${name}`);
    }
  };
  for (const name of Object.keys(judges)) admit(config?.judges?.[name], `judge ${name}`);
  if (!config?.comparison) admit(config?.optimizer, 'optimizer');
  const legacy = () => dependencies.inference?.(timeoutMs) ?? createClaudeInference({ timeoutMs });
  const providers = new Map<string, InferenceProvider>();
  let grants: GrokGrantPool | undefined;
  function provider(name: string, purpose: 'judge' | 'optimizer'): InferenceProvider {
    const model = config!.models[name]!;
    // Broker grants record their purpose, so a broker model gets one provider per purpose.
    const key = model.provider === 'grok-broker' ? `${name}\0${purpose}` : name;
    if (providers.has(key)) return providers.get(key)!;
    const selected = dependencies.modelInference?.(model, timeoutMs) ?? (model.provider === 'claude-subscription'
      ? createClaudeInference({ timeoutMs }) : model.provider === 'codex-subscription'
        ? createCodexInference({ timeoutMs }) : model.provider === 'grok-subscription'
        ? createGrokInference({ timeoutMs, reasoningEffort: model.reasoning_effort })
        : model.provider === 'grok-broker' ? createGrokBrokerInference({ pool: grants ??= grokGrantPool(dependencies), homeRoot: brokerHomeRoot(), purpose, timeoutMs,
          reasoningEffort: model.reasoning_effort as 'low' | 'medium' | 'high' })
          : createOllamaInference({ baseUrl: model.endpoint ?? 'http://127.0.0.1:11434', timeoutMs, think: model.think, keepAliveSeconds: model.keep_alive_seconds, maxOutputTokens: model.max_output_tokens, contextWindowTokens: model.context_window }));
    providers.set(key, selected);
    return selected;
  }
  function route(policy: TrainingRoute, id: string, purpose: 'judge' | 'optimizer'): InferenceProvider {
    const names = [policy.model, ...(policy.fallbacks ?? [])];
    return createRoutedInference({ id, routes: names.map(name => ({ provider: provider(name, purpose), model: config!.models[name]!.model })),
      maxAttempts: policy.attempts ?? names.length, timeoutMs: Math.min(timeoutMs, policy.timeout_ms ?? timeoutMs) });
  }
  const versions = judgeVersions(config, executionIdentity, Object.keys(judges));
  let legacyProvider: InferenceProvider | undefined;
  const getLegacy = () => {
    if (legacyProvider) return legacyProvider;
    const selected = legacy();
    legacyProvider = executionIdentity === undefined ? selected : { ...selected,
      id: judgeVersions(undefined, executionIdentity, ['legacy']).legacy!.version,
      generate: request => selected.generate(request) };
    return legacyProvider;
  };
  const evaluationJudges: Record<string, JudgeRoute> = Object.fromEntries(Object.entries(judges).map(([name, model]) => {
    const policy = config?.judges?.[name];
    if (!policy) return [name, { provider: getLegacy(), model, identity: versions[name]!.version, citationRepairs: repairs[name]! }];
    const identity = versions[name]!.version;
    return [name, { provider: route(policy, identity, 'judge'), model, identity, citationRepairs: repairs[name]!,
      template: policy.template, protocol: policy.protocol,
      cache: config!.cache?.mode === 'exact' ? createJudgeCache({ maxEntries: config!.cache.max_entries ?? 1000 }) : undefined }];
  }));
  const optimizer = config?.optimizer;
  const identity = optimizer === undefined ? undefined : createHash('sha256').update(JSON.stringify({ optimizer, models: config!.models, providerPolicies: trainingRoutePolicies(config!, optimizer, executionIdentity) })).digest('hex');
  const inference = config?.comparison ? undefined : optimizer === undefined ? getLegacy() : route(optimizer, `paideia.optimizer:${identity}`, 'optimizer');
  return { get inference() {
    if (inference === undefined) throw new Error('Authored comparison has no optimizer inference');
    return inference;
  }, judges: evaluationJudges,
  /** Release every broker grant; bounded inside the pool. Commands await it on every exit path. */
  close: async (): Promise<void> => { await grants?.close(); } };
}

/**
 * The training container supplies the broker control socket and a private evaluator
 * home root through the environment; neither is guessed. Missing values fail every
 * broker-grant call closed instead of reaching a desktop Grok login.
 */
function grokGrantPool(dependencies: CliDependencies): GrokGrantPool {
  const socket = process.env[grokBrokerControlSocketEnv];
  return new GrokGrantPool({ id: socket ?? 'unconfigured',
    authority: dependencies.grokGrantAuthority ?? (() => loadDaimonGrokGrantAuthority(socket)) });
}
const brokerHomeRoot = (): string | undefined => process.env[grokGrantHomeRootEnv] || undefined;

/** Plain data only: dry-run must never construct a provider. */
export function configuredCostRoutes(args: CliArguments, judges: Record<string, string>, repairs: Record<string, 0 | 1>) {
  const config = args.training;
  const describe = (policy: TrainingRoute) => {
    const models = [policy.model, ...(policy.fallbacks ?? [])].map(name => config!.models[name]!);
    return { ...models[0]!, fallbacks: models.slice(1), attempts: policy.attempts ?? models.length };
  };
  return { judges: Object.fromEntries(Object.entries(judges).map(([name, model]) => [name,
    { ...(config?.judges?.[name] ? describe(config.judges[name]) : { model, provider: 'claude-subscription' as const }), citationRepairs: repairs[name]! }])),
    optimizerRoute: config?.optimizer === undefined ? undefined : describe(config.optimizer) };
}

export type ConfiguredInferenceModel = TrainingModel;
