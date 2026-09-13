/** Native execution is independent of the dataset language and evaluator registry. */
export interface Usage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  /** Cache reads and writes are disjoint subsets of total inputTokens. Missing means unknown. */
  cacheWriteInputTokens?: number | null;
  cacheWrite5mInputTokens?: number | null;
  cacheWrite1hInputTokens?: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  source: string;
}

export interface ObservationCoverage {
  channel: 'tools' | 'output' | 'usage';
  completeness: 'complete' | 'partial' | 'absent';
  ordering: 'source' | 'causal' | 'none';
}

export interface Observation {
  id: string;
  source: string;
  /** Monotonic within this source; never a global causal-order claim. */
  seq: number;
  type: 'tool.dispatch' | 'tool.complete' | 'output' | 'usage' | 'diagnostic';
  timestamp: string;
  trialId: string;
  wakeId: string;
  callId?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  success?: boolean;
  text?: string;
  usage?: Usage;
  causalParents?: string[];
  native?: unknown;
}

export interface SubjectCapabilities {
  toolTrace: 'none' | 'partial' | 'complete';
  /** A fixture journal never implies observation of every native built-in tool. */
  liveObservations: boolean;
  cancellation: 'none' | 'process-group' | 'native-handle';
  multiTurn: boolean;
  resources: readonly ('instructions' | 'supporting-files' | 'native-skills')[];
  isolation: string;
  readIsolation: 'none' | 'declared-paths';
  protectedPaths: boolean;
}

export interface StopReceipt {
  state: 'requested' | 'acknowledged' | 'unknown';
  scope: 'process' | 'process-group' | 'native-handle';
  quiescence: 'confirmed' | 'unknown';
  remoteWork: 'unknown';
  reason: string;
  detail: string;
}

export interface FixtureTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface SubjectStart {
  trialId: string;
  workspacePath: string;
  runtimeHomePath: string;
  /** Evaluator-owned roots denied by adapters with native path protections. */
  protectedPaths?: readonly string[];
  instructions: string;
  model?: string;
  tools?: readonly FixtureTool[];
  onObservation: (observation: Observation) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface SubjectTurnResult {
  status: 'completed' | 'failed' | 'cancelled';
  text: string;
  coverage: ObservationCoverage[];
  usage: Usage | null;
  error?: string;
  stop?: StopReceipt;
}

export interface SubjectSession {
  run(turn: { id: string; text: string }, signal?: AbortSignal): Promise<SubjectTurnResult>;
  stop(reason: string): Promise<StopReceipt>;
}

export interface SubjectAdapter {
  id: string;
  capabilities: SubjectCapabilities;
  start(input: SubjectStart): Promise<SubjectSession>;
}

export interface InferenceRequest {
  prompt: string;
  system?: string;
  model: string;
  signal?: AbortSignal;
  /** Controls must be rejected if unsupported, never silently discarded. */
  temperature?: number;
  seed?: number;
}

export type InferenceModelBasis = 'provider-reported' | 'requested-assumption';

export interface InferenceResult {
  text: string;
  model: string;
  /** Omitted means provider-reported for existing providers. Requested fallback is never actual-model evidence. */
  modelBasis?: InferenceModelBasis;
  usage: Usage | null;
  route: string;
}

export interface InferenceProvider {
  id: string;
  capabilities: { tools: 'disabled'; billing: 'subscription'; temperature: false; seed: false };
  generate(request: InferenceRequest): Promise<InferenceResult>;
}
