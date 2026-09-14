import type { JudgeRoute } from '../../contracts/evaluation.js';
import { createHash } from 'node:crypto';
import type { InferenceProvider } from '../../contracts/index.js';
import type { TrainingModel, TrainingRoute } from '../../contracts/training-config.js';
import { createClaudeInference, createGrokInference, createOllamaInference, createRoutedInference } from '../../inference/index.js';
import { createJudgeCache } from '../../evaluation/index.js';
import { judgeVersions } from './configuration.js';
import type { CliArguments } from '../arguments.js';
import type { CliDependencies } from '../types.js';

/** Construct only after dry-run and schema preflight have finished. */
export function createTrainingInference(args: CliArguments, dependencies: CliDependencies, timeoutMs: number,
  judges: Record<string, string>, repairs: Record<string, 0 | 1>) {
  const config = args.training;
  const legacy = () => dependencies.inference?.(timeoutMs) ?? createClaudeInference({ timeoutMs });
  const providers = new Map<string, InferenceProvider>();
  function provider(name: string): InferenceProvider {
    if (providers.has(name)) return providers.get(name)!;
    const model = config!.models[name]!;
    const selected = dependencies.modelInference?.(model, timeoutMs) ?? (model.provider === 'claude-subscription'
      ? createClaudeInference({ timeoutMs }) : model.provider === 'grok-subscription'
        ? createGrokInference({ timeoutMs }) : createOllamaInference({ baseUrl: model.endpoint ?? 'http://127.0.0.1:11434', timeoutMs }));
    providers.set(name, selected);
    return selected;
  }
  function route(policy: TrainingRoute, id: string): InferenceProvider {
    const names = [policy.model, ...(policy.fallbacks ?? [])];
    return createRoutedInference({ id, routes: names.map(name => ({ provider: provider(name), model: config!.models[name]!.model })),
      maxAttempts: policy.attempts ?? names.length, timeoutMs: Math.min(timeoutMs, policy.timeout_ms ?? timeoutMs) });
  }
  const versions = judgeVersions(config);
  let legacyProvider: InferenceProvider | undefined;
  const getLegacy = () => legacyProvider ??= legacy();
  const evaluationJudges: Record<string, JudgeRoute> = Object.fromEntries(Object.entries(judges).map(([name, model]) => {
    const policy = config?.judges?.[name];
    if (!policy) return [name, { provider: getLegacy(), model, citationRepairs: repairs[name]! }];
    const identity = versions[name]!.version;
    return [name, { provider: route(policy, identity), model, identity, citationRepairs: repairs[name]!,
      template: policy.template,
      cache: config!.cache?.mode === 'exact' ? createJudgeCache({ maxEntries: config!.cache.max_entries ?? 1000 }) : undefined }];
  }));
  const optimizer = config?.optimizer;
  const identity = optimizer === undefined ? undefined : createHash('sha256').update(JSON.stringify({ optimizer, models: config!.models })).digest('hex');
  return { inference: optimizer === undefined ? getLegacy() : route(optimizer, `paideia.optimizer:${identity}`), judges: evaluationJudges };
}

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
