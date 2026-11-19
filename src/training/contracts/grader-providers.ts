import { AsyncLocalStorage } from 'node:async_hooks';
import type { InferenceProvider } from './execution.js';

export interface GraderTeacher { id: string; provider: string; model: string; effort?: string }
export interface ProviderAvailabilityWindow { start: string; end: string; timeZone?: string }
export interface GraderProviderDescriptor {
  id: string;
  inferenceProviderId: string;
  decisionTools: 'disabled' | 'contained';
  teacherPolicy: string;
  decompositionExtractor: boolean;
  atomicExtractor: boolean;
  validateAtomicConfig(config: GraderTeacher): void;
  create(config: GraderTeacher, timeoutMs?: number): InferenceProvider;
}
export interface CouncilProviderPolicy {
  requiredProviders: readonly string[];
  requiredMessage: string;
  defaultWindow: ProviderAvailabilityWindow;
  windowOpen(now: Date, window?: ProviderAvailabilityWindow): boolean;
  limitedProvider: string;
  outsideWindow(window: ProviderAvailabilityWindow): string;
  closedWindow(phase: 'adjudication' | 'teacher'): string;
  extractorMessage: string;
}
export interface GraderProviderRegistry {
  providers: readonly GraderProviderDescriptor[];
  council: CouncilProviderPolicy;
}
let configured: GraderProviderRegistry | undefined;
const scoped = new AsyncLocalStorage<GraderProviderRegistry>();

function checked(registry: GraderProviderRegistry): GraderProviderRegistry {
  const ids = registry.providers.map(provider => provider.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate grader provider');
  registry.providers.forEach(Object.freeze);
  Object.freeze(registry.providers);
  Object.freeze(registry.council.requiredProviders);
  Object.freeze(registry.council.defaultWindow);
  Object.freeze(registry.council);
  return Object.freeze(registry);
}

/** Standalone composition can install one immutable global grader registry. */
export function configureGraderProviders(registry: GraderProviderRegistry): void {
  if (configured && configured !== registry) throw new Error('Grader provider registry is already configured');
  configured = checked(registry);
}

/** Keep an embedded command's adapter policies local to that invocation. */
export function withGraderProviders<T>(registry: GraderProviderRegistry, run: () => T): T {
  return scoped.run(checked(registry), run);
}

export function graderProviderRegistry(): GraderProviderRegistry {
  const registry = scoped.getStore() ?? configured;
  if (!registry) throw new Error('Grader provider registry is not configured');
  return registry;
}
export function graderProvider(id: string): GraderProviderDescriptor {
  const provider = graderProviderRegistry().providers.find(provider => provider.id === id);
  if (!provider) throw new Error(`Unsupported grader provider ${id}`);
  return provider;
}
