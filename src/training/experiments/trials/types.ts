import type { ResolvedRecord, TaskInput } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationRegistry, EvaluationResult, EvaluationSnapshot, PlanEvaluation, Verdict } from '../../contracts/evaluation.js';
import type { FixtureTool, Observation, StopReceipt, SubjectAdapter, SubjectStartupDiagnostic, SubjectTurnResult } from '../../contracts/execution.js';

export interface TrialPaths { root: string; workspace: string; control: string; runtimeHome: string }
export interface PreparedTrial {
  instructions: string;
  tools?: readonly FixtureTool[];
  /** Trusted collector; acceptedCallId may only originate in authentic filing receipts. */
  collect?: () => Promise<EvaluationSnapshot['artifacts']>;
}
export interface TrialEvent { type: string; payload: unknown }
export interface TrialOptions {
  id: string;
  phase: 'train' | 'validation' | 'test';
  record: ResolvedRecord;
  candidateId: string;
  datasetDigest: string;
  planDigest: string;
  adapter: SubjectAdapter;
  model: string;
  root: string;
  /** Optional caller-owned subject-only scratch; evaluator data remains under root. */
  subjectRoot?: string;
  timeoutMs: number;
  resources?: Readonly<Record<string, string>>;
  protectedPaths?: readonly string[];
  prepare(paths: TrialPaths, signal: AbortSignal): Promise<PreparedTrial>;
  registry: EvaluationRegistry;
  evaluation: Pick<EvaluationContext, 'judges' | 'embeddings' | 'readText' | 'observeJudgeAttempt'>;
  /** Awaited durable sink. A write failure interrupts the trial. */
  persist(event: TrialEvent): Promise<void>;
  signal?: AbortSignal;
}
export interface TurnReport { id: string; native: SubjectTurnResult; checks: EvaluationResult[] }
export interface TrialReport {
  schema: 'paideia.trial.v1';
  id: string;
  phase: TrialOptions['phase'];
  candidateId: string;
  datasetDigest: string;
  planDigest: string;
  recordId: string;
  paths: TrialPaths;
  status: Verdict;
  execution: 'completed' | 'interrupted' | 'failed';
  hostWork: 'settled' | 'incomplete';
  snapshot: EvaluationSnapshot;
  /** Authored turn count, retained independently of returned native results. */
  expectedTurns?: number;
  turns: TurnReport[];
  evaluation: PlanEvaluation;
  live: { checkId: string; boundary: string; result: EvaluationResult }[];
  /** Only the monitor's stop-selected final mechanical witness, never advisory findings. */
  decisiveFailure?: EvaluationResult;
  /** Adapter-published, redacted account of a subject that never became ready; it outlives the runtime it happened in. */
  diagnostic?: SubjectStartupDiagnostic;
  stop?: StopReceipt;
  error?: string;
}
export interface TurnInput { id: string; input: TaskInput }
export interface BindingScope { events: readonly Observation[]; context: EvaluationSnapshot['context'] }
