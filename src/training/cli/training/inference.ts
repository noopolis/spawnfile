import { defaultInferenceProviders } from '../../providers/index.js';
import type { InferenceProviderRegistry } from '../../contracts/inference-registry.js';
import { inferenceProviderDescriptor } from '../../contracts/inference-registry.js';
import { OPTIMIZER_ROUTE_PREFIX } from '../../contracts/index.js';
import { trainingEnvironment } from '../../platform/index.js';
import { trainingRoutePolicies, trainingInferencePolicies } from '../../providers/index.js';
import type { JudgeRoute } from '../../contracts/evaluation.js';
import { createHash } from 'node:crypto';
import type { InferenceProvider } from '../../contracts/index.js';
import type { TrainingModel, TrainingRoute } from '../../contracts/training-config.js';
import { assertModelRequestAdmission, budgetEvaluatorInference, createRoutedInference } from '../../inference/index.js';
import { createJudgeCache } from '../../evaluation/index.js';
import { judgeVersions } from './configuration.js';
import type { CliArguments } from '../arguments.js';
import type { CliDependencies } from '../types.js';

/** Construct only after dry-run and schema preflight have finished. */
export function createTrainingInference(args: CliArguments, dependencies: CliDependencies, timeoutMs: number,
  judges: Record<string, string>, repairs: Record<string, 0 | 1>) {
  const config = args.training;
  const registry = dependencies.inferenceProviders ?? defaultInferenceProviders;
  const executionIdentity = dependencies.spawnfile?.inferenceExecutionIdentity;
  trainingInferencePolicies(config, executionIdentity, registry);
  // Validate every reachable route before constructing even the first provider.
  const admit = (policy: TrainingRoute | undefined, purpose: string) => {
    if (!policy) return assertModelRequestAdmission(registry.defaultProviderId, `${purpose} legacy default`, undefined, registry);
    for (const name of [policy.model, ...(policy.fallbacks ?? [])]) {
      assertModelRequestAdmission(config!.models[name]!.provider, `${purpose} model ${name}`, purpose === 'optimizer' ? { purpose: 'proposals', model: config!.models[name]!.model } : undefined, registry);
    }
  };
  for (const name of Object.keys(judges)) admit(config?.judges?.[name], `judge ${name}`);
  if (!config?.comparison) admit(config?.optimizer, 'optimizer');
  const resources = new Map<string, unknown>();
  const cleanup: (() => Promise<void>)[] = [];
  const context = (purpose: 'judge' | 'optimizer', timeoutMs: number) => ({ timeoutMs, purpose, resources, onClose: (close: () => Promise<void>) => { cleanup.push(close); } });
  const legacy = () => dependencies.inference?.(timeoutMs) ?? inferenceProviderDescriptor(registry, registry.defaultProviderId)
    .create({ provider: registry.defaultProviderId, model: '' }, context('optimizer', timeoutMs));
  const providers = new Map<string, InferenceProvider>();
  function provider(name: string, purpose: 'judge' | 'optimizer', routeTimeoutMs: number): InferenceProvider {
    const model = config!.models[name]!;
    // Broker grants and evaluator budgets attach to purpose-specific providers; each route timeout gets its own provider.
    const descriptor = inferenceProviderDescriptor(registry, model.provider);
    const purposeKeyed = descriptor.capabilities.purposeScoped || trainingEnvironment('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP') === 'broker' || trainingEnvironment('SPAWNFILE_TRAINING_EVALUATOR_ROUTES_FILE') !== undefined;
    const key = `${name}\0${purposeKeyed ? purpose : ''}\0${routeTimeoutMs}`;
    if (providers.has(key)) return providers.get(key)!;
    const timeoutMs = routeTimeoutMs;
    const selected = dependencies.modelInference?.(model, timeoutMs) ?? descriptor.create(model, context(purpose, timeoutMs));
    const admitted = purpose === 'optimizer' ? budgetEvaluatorInference(selected, model.provider, 'proposals', model.model, registry) : selected;
    providers.set(key, admitted);
    return admitted;
  }
  function route(policy: TrainingRoute, id: string, purpose: 'judge' | 'optimizer'): InferenceProvider {
    const names = [policy.model, ...(policy.fallbacks ?? [])];
    const routeTimeoutMs = policy.timeout_ms ?? timeoutMs;
    return createRoutedInference({ id, routes: names.map(name => ({ provider: provider(name, purpose, routeTimeoutMs), model: config!.models[name]!.model })),
      maxAttempts: policy.attempts ?? names.length, timeoutMs: routeTimeoutMs });
  }
  const versions = judgeVersions(config, executionIdentity, Object.keys(judges), registry);
  let legacyProvider: InferenceProvider | undefined;
  const getLegacy = () => {
    if (legacyProvider) return legacyProvider;
    const selected = legacy();
    legacyProvider = executionIdentity === undefined ? selected : { ...selected,
      id: judgeVersions(undefined, executionIdentity, ['legacy'], registry).legacy!.version,
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
  const identity = optimizer === undefined ? undefined : createHash('sha256').update(JSON.stringify({ optimizer, models: config!.models, providerPolicies: trainingRoutePolicies(config!, optimizer, executionIdentity, registry) })).digest('hex');
  const inference = config?.comparison ? undefined : optimizer === undefined ? getLegacy() : route(optimizer, `${OPTIMIZER_ROUTE_PREFIX}${identity}`, 'optimizer');
  return { get inference() {
    if (inference === undefined) throw new Error('Authored comparison has no optimizer inference');
    return inference;
  }, judges: evaluationJudges,
  /** Release every broker grant; bounded inside the pool. Commands await it on every exit path. */
  close: async (): Promise<void> => { await Promise.all(cleanup.map(close => close())); } };
}

/** Plain data only: dry-run must never construct a provider. */
export function configuredCostRoutes(args: CliArguments, judges: Record<string, string>, repairs: Record<string, 0 | 1>, registry: InferenceProviderRegistry = defaultInferenceProviders) {
  const config = args.training;
  const describe = (policy: TrainingRoute) => {
    const models = [policy.model, ...(policy.fallbacks ?? [])].map(name => config!.models[name]!);
    return { ...models[0]!, fallbacks: models.slice(1), attempts: policy.attempts ?? models.length };
  };
  return { judges: Object.fromEntries(Object.entries(judges).map(([name, model]) => [name,
    { ...(config?.judges?.[name] ? describe(config.judges[name]) : { model, provider: registry.defaultProviderId }), citationRepairs: repairs[name]! }])),
    optimizerRoute: config?.optimizer === undefined ? undefined : describe(config.optimizer) };
}

export type ConfiguredInferenceModel = TrainingModel;
