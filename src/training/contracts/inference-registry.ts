import type { InferenceProvider } from './execution.js';
import type { TrainingModel } from './training-config.js';

/** One command shares resources and awaits registered cleanup on every exit. */
export interface InferenceProviderFactoryContext {
  timeoutMs: number;
  purpose: 'judge' | 'optimizer';
  resources: Map<string, unknown>;
  onClose(callback: () => Promise<void>): void;
}

/** Registration is data and validation; factories run only after preflight. */
export interface InferenceProviderDescriptor {
  policyVersion: string;
  /** Historical default-judge identity, when distinct from the invocation policy. */
  legacyJudgeVersion?: string;
  validate(model: Readonly<Record<string, unknown>>, path: string): void;
  normalizeIdentity?(model: TrainingModel): TrainingModel;
  capabilities: {
    purposeScoped?: boolean;
    brokerAdmission?: boolean;
    evaluatorPurposes?: readonly string[];
    evaluatorBudget?: 'requests' | 'usd';
  };
  incompatibleWith?: readonly string[];
  incompatibilityReason?: string;
  create(model: TrainingModel, context: InferenceProviderFactoryContext): InferenceProvider;
}

/** Runtime composition supplies all available provider implementations. */
export interface InferenceProviderRegistry {
  providers: Readonly<Record<string, InferenceProviderDescriptor>>;
  defaultProviderId: string;
  brokerAdmissionLabel?: string;
  /** Dedicated decision services share admission without pretending to generate text. */
  evaluatorProviders?: Readonly<Record<string, { purposes: readonly string[]; budget: 'requests' | 'usd' }>>;
}

export function inferenceProviderDescriptor(registry: InferenceProviderRegistry, id: string): InferenceProviderDescriptor {
  const descriptor = Object.hasOwn(registry.providers, id) ? registry.providers[id] : undefined;
  if (!descriptor) throw new Error(`Unknown inference provider ${id}`);
  return descriptor;
}
