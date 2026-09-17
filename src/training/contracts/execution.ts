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
  /** Runtime-reported notional API-equivalent USD for exactly these tokens, labelled by `source`. Missing means unreported. */
  notionalUsd?: number | null;
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
  type: 'tool.dispatch' | 'tool.complete' | 'output' | 'usage' | 'diagnostic' | 'input';
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

/**
 * What an adapter publishes about a subject that never became ready.
 *
 * The failure class has to survive the runtime it happened in: an adapter may
 * keep its full capture on storage that dies with the container, so this is the
 * redacted record that reaches the durable run output. `reason` is the runtime's
 * own stated failure and is safe to show an operator. `streams` are redacted
 * captures; an adapter that cannot prove a secret was removed omits them and
 * reports `redaction: 'withheld'`, so the defect class still lands even when the
 * bytes cannot. `protectedArtifact` names the adapter-private full copy.
 */
export interface SubjectStartupDiagnostic {
  schema: string;
  trialId: string;
  reason: string;
  exitCode: number | null;
  exitSignal: string | null;
  redaction: 'applied' | 'withheld';
  streams?: { stdout: string; stderr: string; truncated: { stdout: boolean; stderr: boolean } };
  protectedArtifact?: string;
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
  /** Optional JSON Schema; supported providers constrain and validate the completed text. */
  responseSchema?: Readonly<Record<string, unknown>>;
  /** Trusted evaluator-only sink; never serialize into prompts, results or checkpoints. */
  observeFailure?: (observation: { attempt: Readonly<InferenceAttempt>; fallbackOf?: string; diagnostic: InferenceDiagnostic }) => void | Promise<void>;
  model: string;
  signal?: AbortSignal;
  /** Controls must be rejected if unsupported, never silently discarded. */
  temperature?: number;
  seed?: number;
}

export type InferenceModelBasis = 'provider-reported' | 'requested-assumption';

/** `auth-stale`: a shared credential authority (a broker realm) is stale; routes on that authority fail fast. */
export type InferenceFailureKind = 'quota' | 'transport' | 'unavailable' | 'authentication' | 'auth-stale' |
  'protocol' | 'invalid-response' | 'cancelled' | 'timeout' | 'unsupported' | 'unknown';

export const inferenceDiagnosticCodes = ['initialization', 'tool-isolation', 'subscription', 'transport-framing', 'native-process',
    'terminal-error', 'unfinished-response', 'empty-response', 'response-mismatch', 'session-mismatch',
    'stop-mismatch', 'model-missing', 'content-shape', 'response-envelope', 'response-schema'] as const;

/** Protected provider evidence. Codes never contain arbitrary native error prose. */
export interface InferenceDiagnostic {
  code: (typeof inferenceDiagnosticCodes)[number];
  /** Only an attested completed schema-rejected answer; oversized text is explicitly omitted. */
  response?: { bytes: number; sha256: string; text?: string; omitted: boolean };
}

/** One settled or interrupted inference attempt, without prompts or provider diagnostics. */
export interface InferenceAttempt {
  id: string;
  ordinal: number;
  providerId: string;
  requestedModel: string;
  responseModel: string | null;
  responseRoute: string | null;
  outcome: 'completed' | 'failed';
  failureKind: InferenceFailureKind | null;
  startedAt: string;
  completedAt: string;
  usage: Usage | null;
}

export interface InferenceResult {
  text: string;
  model: string;
  /** Omitted means provider-reported for existing providers. Requested fallback is never actual-model evidence. */
  modelBasis?: InferenceModelBasis;
  usage: Usage | null;
  route: string;
  /** All attempted declared routes, including failures. Omitted by unrouted legacy providers. */
  attempts?: readonly InferenceAttempt[];
}

export interface InferenceProvider {
  id: string;
  capabilities: { tools: 'disabled'; billing: 'subscription' | 'api' | 'local' | 'mixed'; temperature: boolean; seed: boolean;
    /** Shared credential authority; after `auth-stale` routing skips every later route naming the same authority. */
    credentialAuthority?: string };
  generate(request: InferenceRequest): Promise<InferenceResult>;
}
