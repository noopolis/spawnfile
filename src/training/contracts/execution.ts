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

/**
 * Why a CLOSURE proof did not settle, as a closed vocabulary rather than prose.
 *
 * Closure answers one question — is anything still running or still spending? —
 * and it is the conjunction of three independent proofs: the owned child process
 * exited, the runtime sealed its own stop and acknowledged it, and the runtime's
 * own activity projection admits no execution. For as long as the failing proof
 * was swallowed, every unscorable run looked identical: two sessions in a row had
 * to guess which one was missing from a control root that dies with its
 * container. Absent means closure was proven; the value names the FIRST proof
 * that did not hold, and never carries a path, a token, a body or an error
 * string.
 *
 * What a trial can be SCORED from is a separate question with its own vocabulary
 * (`TerminalEvidenceMissing`). Four members below are retired: they were scoring
 * facts that had been placed inside this predicate, where each one demoted a
 * healthy run to an infrastructure failure. They are kept so a sealed report that
 * carries one still replays; nothing produces them.
 */
export type StopUnconfirmed =
  | 'worker-unavailable'
  /**
   * Retired as closure causes, and reported as `unevidenced` instead. A terminal
   * frame that never arrived, or that did not bind to this trial, says nothing
   * about whether a worker is still spending: it is a fact about the last
   * delivery's paperwork, read out of another service's inbox bookkeeping over
   * HTTP. The live proofs beside it — no admitted execution, a sealed
   * acknowledged stop, an exited child — are what that claim rests on.
   */
  | 'terminal-absent'
  | 'terminal-unbound'
  /**
   * Retired as a closure cause. The delivery's disposition is a SCORING fact:
   * reading it here demoted a scorable turn to an infrastructure failure, and the
   * live proofs beside it already establish that no worker is still spending. A
   * recurrence is an upstream regression and fails on the worker's own evidence
   * instead.
   */
  | 'delivery-undisposed'
  | 'activity-unreadable'
  | 'activity-busy'
  /** The activity projection omitted its execution authority or listed another agent's execution. */
  | 'execution-unbound'
  | 'native-stop-unacknowledged'
  | 'child-running'
  | 'child-exit';

/**
 * Why a trial has no terminal evidence to be scored from — which is NOT a closure
 * fault and must never read as one.
 *
 * "The runtime might still be spending" and "this turn cannot be scored" call for
 * fixes in different places, and collapsing them sent seven investigations after
 * the wrong layer: a healthy, closed, idle, exited run kept publishing as unproven
 * containment because its frame did not bind. A trial carrying one of these is
 * unscorable for want of evidence, on a runtime that is provably quiet.
 *
 * `terminal-absent` is no frame at all for the last delivery; `terminal-unbound`
 * is a frame whose identity, closed trace or resolved execution disagreed —
 * including a frame belonging to a different trial, which is never accepted as
 * this one's evidence.
 *
 * `terminal-ambiguous` is the third, and it is not a weaker `terminal-unbound`:
 * the frame named an execution and the trial carries MORE THAN ONE closed trace
 * for that same id, so nothing here can say which one the frame accounts for. A
 * trial that legitimately ran several wakes resolves the one its frame names and
 * is scored; two traces answering to one name is a runtime defect and fails
 * closed under its own word, because the fix it calls for is not in Paideia.
 */
export type TerminalEvidenceMissing = 'terminal-absent' | 'terminal-unbound' | 'terminal-ambiguous';

export interface StopReceipt {
  state: 'requested' | 'acknowledged' | 'unknown';
  scope: 'process' | 'process-group' | 'native-handle';
  quiescence: 'confirmed' | 'unknown';
  remoteWork: 'unknown';
  reason: string;
  detail: string;
  /** Set only on an unconfirmed stop, and only by an adapter that knows which proof failed. */
  unconfirmed?: StopUnconfirmed;
  /**
   * Set when this trial has no terminal evidence to be scored from. It is
   * independent of `quiescence`: a run can be provably closed and still
   * unscorable, and that pair is the whole point of keeping two names.
   */
  unevidenced?: TerminalEvidenceMissing;
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
  /** Structured frames the runtime printed. A frame's schema publishes even when its message cannot. */
  frames?: { stream: 'stdout' | 'stderr'; schema: string; message?: string; withheldBy?: readonly string[] }[];
  /** Why a stream could not be published, in enough detail to tell one failure class from another. */
  withheld?: { stream: 'stdout' | 'stderr'; bytes: number; lines: number; frame: string | null; detectors: readonly string[] }[];
  protectedArtifact?: string;
  /** Operator-only full capture on the operator's own run output, written by the caller. Never shipped to a viewer or report. */
  operatorCapture?: string;
}

/**
 * The unredacted capture an adapter hands its caller exactly once.
 *
 * It never enters the durable event stream, a report or a viewer projection: the
 * caller writes it to the operator's own run output as an operator-only file and
 * then keeps only its path. `basename` is adapter-suggested and caller-validated.
 */
export interface SubjectStartupCapture {
  basename: string;
  content: string;
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
  /**
   * The subject's own execution closed while its delivery stayed accepted and
   * deferred awaiting external input. The turn is never `completed`: confirming
   * closure changes no task outcome and makes no unanswered delivery eligible as
   * completed training evidence. An adapter sets it only with that explicit
   * blocked receipt and the identity, idle, stop and exit proofs behind it, so a
   * hang, crash, abort or deadline never carries it.
   */
  blocked?: 'awaiting-external-input';
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

/**
 * What `kind` alone cannot express, as a closed vocabulary rather than prose.
 *
 * A borrowed inference grant has three different ways to stop working and `kind`
 * collapsed all of them onto `unavailable`: the broker refusing to lend one, the
 * lent grant outliving its own expiry, and the broker simply being down. A judge
 * that reports only `unavailable` cannot tell an operator which of those to fix,
 * so the adapter that knows names it here. Absent means the adapter had nothing
 * more specific than `kind`; it never carries a token, a URL, a body or prose.
 */
export const inferenceFailureDetails = ['grant-refused', 'grant-expired', 'provider-status'] as const;
export type InferenceFailureDetail = (typeof inferenceFailureDetails)[number];

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
