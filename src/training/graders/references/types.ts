import type { InferenceProvider, Usage, InferenceAttempt } from '../../contracts/index.js';
import type { CheckInstance } from '../decomposition/index.js';

export interface CouncilTeacher { id: string; provider: string; model: string; effort?: string }
export interface GrokWindow { start: string; end: string; timeZone?: string }
export interface TeacherAnswer { answer: string; p?: number; span?: string }
export interface ReferenceCall {
  id: string; teacher: string; provider: string; requestedModel: string;
  reportedModel: string | null; route: string | null; prompt_digest: string;
  phase: 'teacher' | 'adjudication'; run?: number; check_ids: string[];
  at: string; wallMs: number; usage: Usage | null; attempts?: readonly InferenceAttempt[];
  outcome: 'received' | 'completed' | 'invalid-response' | 'generation-error' | 'cancelled';
  response_text?: string; answers?: Record<string, TeacherAnswer> | null;
}
export interface CheckReference {
  digest: string; template_id: string; teachers: Record<string, TeacherAnswer>;
  distribution: Record<string, number>; unknown_mass: number;
  adjudication: TeacherAnswer[]; final: string | null;
  status: 'agreed' | 'adjudicated' | 'uncertain';
}
export interface CouncilOutput {
  outputDigest: string; identity: string; digest: string; complete: boolean;
  checks: Record<string, CheckReference>; calls: ReferenceCall[]; active_teachers?: string[];
  skipped: { teacher: string; reason: string }[];
}
export interface CouncilOptions {
  outputDigest: string; instances: CheckInstance[]; teachers: CouncilTeacher[];
  providers: Record<string, InferenceProvider>; adjudicator?: string;
  grokWindow?: GrokWindow; now?: Date; seed?: string; timeoutMs?: number;
  signal?: AbortSignal; previous?: CouncilOutput; onCheckpoint?: (output: CouncilOutput) => void | Promise<void>;
}
export interface TrapAssessment {
  outputId?: string;
  kind: string; templateId: string; intended: string; actual: string | null;
  baseline?: string | null;
}
