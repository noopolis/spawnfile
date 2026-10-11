import type { CheckInstance, Decomposition, TrapKind } from '../decomposition/index.js';

export interface TrapMutation {
  path: string[]; before: string; after: string; source: string; replacement: string;
  value_before?: string; value_after?: string;
}
export interface Trap {
  id: string; kind: TrapKind; base_unit: string; mutation: TrapMutation;
  affected_template_ids: string[]; intended_answers: Record<string, string>;
  output: unknown; decomposition: Decomposition; instances: CheckInstance[];
  context_digest: string; validation: { valid: boolean; reasons: string[] };
}
export interface TrapSet {
  schema: 'paideia.traps.v1'; seed: string; traps: Trap[]; discarded: number;
  rejections: { kind: TrapKind; unit: string; reason: string }[];
}
