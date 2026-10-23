import type { InferenceGrantAuthority, SubjectAdapter } from '../contracts/index.js';

export interface SubjectAdapterOptions { model: string; timeoutMs: number }
export interface SubjectAdapterRegistration {
  create(options: SubjectAdapterOptions): SubjectAdapter;
  /** Optional host-broker capability; implementation belongs to the subject adapter. */
  hostInference?: { grantAuthority(socketPath: string | undefined): Promise<InferenceGrantAuthority> };
}
export type SubjectAdapterRegistry = Readonly<Record<string, SubjectAdapterRegistration>>;


export function resolveSubjectAdapter(registry: SubjectAdapterRegistry | undefined, id: string, options: SubjectAdapterOptions): SubjectAdapter {
  const registration = registry && Object.hasOwn(registry, id) ? registry[id] : undefined;
  if (!registration) throw new Error(`Supported native runtimes: ${Object.keys(registry ?? {}).join(', ') || 'none registered'}; unknown subject ${id}`);
  return registration.create(options);
}

export function subjectHostInference(registry: SubjectAdapterRegistry | undefined): NonNullable<SubjectAdapterRegistration['hostInference']> {
  const capabilities = Object.values(registry ?? {}).flatMap(subject => subject.hostInference ? [subject.hostInference] : []);
  if (capabilities.length !== 1) throw new Error('Exactly one subject hostInference grant authority must be registered');
  return capabilities[0]!;
}
