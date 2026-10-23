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
/** Composition supplies provider data before loading authored grader files. */
export function configureGraderProviders(registry: GraderProviderRegistry): void {
  const ids = registry.providers.map(provider => provider.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate grader provider');
  if (configured && configured !== registry) throw new Error('Grader provider registry is already configured');
  registry.providers.forEach(Object.freeze);
  Object.freeze(registry.providers);
  Object.freeze(registry.council.requiredProviders);
  Object.freeze(registry.council.defaultWindow);
  Object.freeze(registry.council);
  configured = Object.freeze(registry);
}
export function graderProviderRegistry(): GraderProviderRegistry {
  if (!configured) throw new Error('Grader provider registry is not configured');
  return configured;
}
export function graderProvider(id: string): GraderProviderDescriptor {
  const provider = graderProviderRegistry().providers.find(provider => provider.id === id);
  if (!provider) throw new Error(`Unsupported grader provider ${id}`);
  return provider;
}
