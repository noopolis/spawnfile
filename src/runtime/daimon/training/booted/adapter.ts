import type { Observation, StopReceipt, SubjectAdapter, SubjectOutput, SubjectTurnResult, Usage } from '../../../../training/index.js';

export const BOOTED_ADAPTER_ID = 'daimon-booted';
export const BOOTED_EVIDENCE_SCHEMA = 'spawnfile.training.daimon-booted.wake.v1';

/** One ledger row a wake appended (`noopolis.daimon.turn-usage.v1`), as far as Training reads it. */
export interface BootedUsageRow { input: number; cache_read: number; output: number; total?: number; notional_usd: number; complete: boolean }

export interface BootedWake {
  state: 'completed' | 'deferred' | 'failed' | 'stopped' | 'timeout';
  acceptanceId: string;
  executionId: string | null;
  code: string | null;
  text: string;
  usage: readonly BootedUsageRow[];
  transcript: string | null;
  /** Per model request, the tool-call names its response carried; null where the runtime could not say. */
  requestToolCalls?: readonly (readonly string[] | null)[];
  /** The engine failure Daimon reported for a delivery that did not complete, in full; null when none. */
  failure?: string | null;
}

/**
 * Subscription quota and rate-limit refusals, in the words engines report them. Engine-neutral: it reads only the
 * failure text Daimon relays, and a match means a refused turn, never the subject's behaviour.
 */
const QUOTA_FAILURE = /\b(?:quota|rate[ -]?limit(?:ed)?|usage limit|too many requests|resets? in)\b/iu;

/** The quota sentence of a failure, bounded, or undefined when the failure is not a quota refusal. */
export const quotaFailure = (failure: string | null | undefined): string | undefined => {
  const match = failure ? QUOTA_FAILURE.exec(failure) : null;
  if (!failure || !match) return undefined;
  const start = Math.max(0, failure.lastIndexOf('"', match.index) + 1, match.index - 200);
  return failure.slice(start, match.index + 200).split('"')[0]!.trim();
};

export interface BootedTrialHandle {
  wake(text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }): Promise<BootedWake>;
  /** A workspace-relative file the subject left in its container; null when absent. */
  read(path: string): Promise<string | null>;
  /** Resolves with the failure the runtime still reported at teardown, in full, or null. */
  teardown(): Promise<string | null | void>;
}

/** Boots one trial organization of the subject with the candidate's instructions, from the record's moment if it has one. */
export interface BootedTrialLauncher {
  boot(input: { trialId: string; instructions: string; moment?: unknown; signal?: AbortSignal; evidenceDirectory?: string }): Promise<BootedTrialHandle>;
}

/** The artifact holding a trial's final reply, beside its declared outputs. */
export const BOOTED_REPLY_OUTPUT = 'reply';

/** The runtime's failure as one bounded line of the trial's error; the whole text is the turn's `failureText`. */
const failureReason = (failure: string | null): string => {
  const line = failure?.replace(/\s+/gu, ' ').trim() ?? '';
  return line ? `: ${line.length > 400 ? `${line.slice(0, 400)}...` : line}` : '';
};

export interface BootedAdapterOptions { launcher: BootedTrialLauncher; timeoutMs: number }

/**
 * A wake Daimon killed at its wall-clock bound, in the words its runtime reports it: the broker's sealed
 * `limit=timeout`, a CLI child's own "timed out" or "wall-clock bound". Engine-neutral, like {@link quotaFailure}.
 */
const TIMEOUT_FAILURE = /\blimit=timeout\b|\btimed out\b|\bwall-clock bound\b/iu;
export const timeoutFailure = (failure: string | null | undefined): boolean => Boolean(failure && TIMEOUT_FAILURE.test(failure));

/**
 * Prompt tokens a row spent, cached reads included. Engines disagree on whether `input` already holds the cached
 * reads (a subset) or only the fresh ones (disjoint buckets), but every row's `total` is the sum of what it counted,
 * so `total - output` is the whole prompt either way. Reading a disjoint `input` as the whole left cached reads above
 * input, which the core rejects as invalid usage: the trial then had no usage at all and could not settle.
 */
const promptTokens = (row: BootedUsageRow): number => Math.max(row.input, (row.total ?? row.input + row.output) - row.output);

/** Ledger rows to `Usage`; no rows means unmetered, never zero. */
export const bootedUsage = (rows: readonly BootedUsageRow[]): Usage | null => rows.length === 0 ? null : {
  inputTokens: rows.reduce((sum, row) => sum + promptTokens(row), 0),
  cachedInputTokens: rows.reduce((sum, row) => sum + row.cache_read, 0),
  outputTokens: rows.reduce((sum, row) => sum + row.output, 0),
  reasoningTokens: null,
  notionalUsd: rows.reduce((sum, row) => sum + row.notional_usd, 0),
  source: 'daimon-turn-usage-ledger',
};

/**
 * A training trial as a production-booted organization: the container is the
 * isolation, the wake is the turn, and the evidence is what the runtime itself
 * recorded (receipt, usage ledger, engine transcript).
 */
export function createDaimonBootedAdapter(options: BootedAdapterOptions): SubjectAdapter {
  return {
    id: BOOTED_ADAPTER_ID,
    capabilities: { toolTrace: 'none', liveObservations: false, cancellation: 'native-handle', multiTurn: true,
      // The container is the isolation: it reaches no host path, so every evaluator-owned file is out of reach.
      resources: ['instructions'], readIsolation: 'declared-paths', protectedPaths: true, trialIsolation: 'per-start',
      isolation: 'One production-booted organization container per trial; the subscription login stays in the run auth gateway.' },
    async start(input) {
      const trial = await options.launcher.boot({ trialId: input.trialId, instructions: input.instructions,
        ...(input.setup?.moment === undefined ? {} : { moment: input.setup.moment }), signal: input.signal,
        ...(input.evidencePath === undefined ? {} : { evidenceDirectory: input.evidencePath }) });
      let reply: string | undefined;
      let lastCollected: Record<string, SubjectOutput> = {};
      const source = `${BOOTED_ADAPTER_ID}:${input.trialId}`;
      let seq = 0;
      let stopped: Promise<StopReceipt> | undefined;
      const emit = (wakeId: string, value: Partial<Observation> & Pick<Observation, 'type'>) =>
        input.onObservation({ id: `${source}:${++seq}`, source, seq, trialId: input.trialId, wakeId, timestamp: new Date().toISOString(), ...value });
      const stop = (reason: string): Promise<StopReceipt> => stopped ??= trial.teardown().then(
        // A turn cut short (the trial's deadline, an abort) never returned its failure; the stop receipt names it.
        (failure) => ({ state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason,
          detail: `trial organization container removed${failure ? `; last runtime failure${failureReason(failure)}` : ''}` }),
        (error: unknown) => ({ state: 'unknown', scope: 'native-handle', quiescence: 'unknown', remoteWork: 'unknown', reason, detail: error instanceof Error ? error.message : String(error) }));
      return {
        stop,
        async collect(outputs) {
          // The container is gone once the trial stops; its last reading is the final one.
          if (stopped) return { ...lastCollected };
          const collected: Record<string, SubjectOutput> = {};
          for (const [name, path] of Object.entries(outputs)) {
            const bytes = await trial.read(path);
            if (bytes !== null) collected[name] = { bytes, provenance: `trial-workspace:${path}` };
          }
          if (reply !== undefined && !Object.hasOwn(collected, BOOTED_REPLY_OUTPUT)) collected[BOOTED_REPLY_OUTPUT] = { bytes: reply, provenance: 'trial-reply' };
          lastCollected = collected;
          return { ...collected };
        },
        async run(turn, signal): Promise<SubjectTurnResult> {
          if (stopped) throw new Error('trial organization was already stopped');
          const wake = await trial.wake(turn.text, { deliveryId: `${input.trialId}:${turn.id}`, timeoutMs: options.timeoutMs, signal: signal ?? input.signal });
          reply = wake.text;
          const usage = bootedUsage(wake.usage);
          if (wake.text) await emit(turn.id, { type: 'output', text: wake.text });
          if (usage) await emit(turn.id, { type: 'usage', usage });
          if (wake.transcript) await emit(turn.id, { type: 'diagnostic', native: { schema: BOOTED_EVIDENCE_SCHEMA, transcript: wake.transcript } });
          // A deferral is the subject's own choice to end its turn only when nothing failed: Daimon also defers a
          // delivery whose execution failed again after its one retry, and then reports that failure. Such a delivery
          // is a failed turn, never the subject deferring.
          const failure = wake.state === 'completed' || wake.state === 'stopped' ? null : wake.failure ?? null;
          // A wake still open at the trial's deadline is classified by that deadline alone; its failure only explains it.
          const classified = wake.state === 'timeout' ? null : failure;
          const quota = quotaFailure(classified);
          const ended = wake.state === 'completed' || wake.state === 'deferred' && wake.code === null && failure === null;
          const status = ended ? 'completed' : wake.state === 'stopped' ? 'cancelled' : 'failed';
          // A turn killed at its wall-clock bound after its model made measured progress is the subject missing its
          // deadline, as production would: a declared timeout, scored on what it left. One with no measured model
          // work is a hang, and stays an unlabelled failure for the infrastructure policy.
          const limit = status === 'failed' && quota === undefined && timeoutFailure(classified) && wake.usage.some((row) => row.output > 0) ? 'timeout' as const : undefined;
          return {
            status, text: wake.text, usage,
            evidence: { adapterId: BOOTED_ADAPTER_ID, payload: { schema: BOOTED_EVIDENCE_SCHEMA, acceptanceId: wake.acceptanceId,
              executionId: wake.executionId, state: wake.state, code: wake.code } },
            coverage: [
              { channel: 'output', completeness: ended ? 'complete' : 'partial', ordering: 'none' },
              { channel: 'usage', completeness: usage === null ? 'absent' : wake.usage.every((row) => row.complete) ? 'complete' : 'partial', ordering: 'none' },
              { channel: 'tools', completeness: 'absent', ordering: 'none' },
            ],
            ...(quota === undefined ? {} : { failure: 'quota' as const }),
            ...(limit === undefined ? {} : { limit }),
            ...(failure === null ? {} : { failureText: failure }),
            ...(status === 'completed' ? {} : { error: `trial wake ${wake.state}${wake.code ? ` (${wake.code})` : ''}${quota ? `: subscription quota: ${quota}` : limit ? ': wall-clock bound reached while the subject was working' : failureReason(failure)}` }),
          };
        },
      };
    },
  };
}
