import type { Observation, StopReceipt, SubjectAdapter, SubjectTurnResult, Usage } from '../../../../training/index.js';

export const BOOTED_ADAPTER_ID = 'daimon-booted';
export const BOOTED_EVIDENCE_SCHEMA = 'spawnfile.training.daimon-booted.wake.v1';

/** One ledger row a wake appended (`noopolis.daimon.turn-usage.v1`), as far as Training reads it. */
export interface BootedUsageRow { input: number; cache_read: number; output: number; notional_usd: number; complete: boolean }

export interface BootedWake {
  state: 'completed' | 'failed' | 'stopped' | 'timeout';
  acceptanceId: string;
  executionId: string | null;
  code: string | null;
  text: string;
  usage: readonly BootedUsageRow[];
  transcript: string | null;
  /** Per model request, the tool-call names its response carried; null where the runtime could not say. */
  requestToolCalls?: readonly (readonly string[] | null)[];
}

export interface BootedTrialHandle {
  wake(text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }): Promise<BootedWake>;
  teardown(): Promise<void>;
}

/** Boots one trial organization of the subject with the candidate's instructions. */
export interface BootedTrialLauncher {
  boot(input: { trialId: string; instructions: string; signal?: AbortSignal }): Promise<BootedTrialHandle>;
}

export interface BootedAdapterOptions { launcher: BootedTrialLauncher; timeoutMs: number }

/** Ledger rows to `Usage`; no rows means unmetered, never zero. */
export const bootedUsage = (rows: readonly BootedUsageRow[]): Usage | null => rows.length === 0 ? null : {
  inputTokens: rows.reduce((sum, row) => sum + row.input, 0),
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
      resources: ['instructions'], readIsolation: 'none', protectedPaths: false,
      isolation: 'One production-booted organization container per trial; the subscription login stays in the run auth gateway.' },
    async start(input) {
      const trial = await options.launcher.boot({ trialId: input.trialId, instructions: input.instructions, signal: input.signal });
      const source = `${BOOTED_ADAPTER_ID}:${input.trialId}`;
      let seq = 0;
      let stopped: Promise<StopReceipt> | undefined;
      const emit = (wakeId: string, value: Partial<Observation> & Pick<Observation, 'type'>) =>
        input.onObservation({ id: `${source}:${++seq}`, source, seq, trialId: input.trialId, wakeId, timestamp: new Date().toISOString(), ...value });
      const stop = (reason: string): Promise<StopReceipt> => stopped ??= trial.teardown().then(
        () => ({ state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'trial organization container removed' }),
        (error: unknown) => ({ state: 'unknown', scope: 'native-handle', quiescence: 'unknown', remoteWork: 'unknown', reason, detail: error instanceof Error ? error.message : String(error) }));
      return {
        stop,
        async run(turn, signal): Promise<SubjectTurnResult> {
          if (stopped) throw new Error('trial organization was already stopped');
          const wake = await trial.wake(turn.text, { deliveryId: `${input.trialId}:${turn.id}`, timeoutMs: options.timeoutMs, signal: signal ?? input.signal });
          const usage = bootedUsage(wake.usage);
          if (wake.text) await emit(turn.id, { type: 'output', text: wake.text });
          if (usage) await emit(turn.id, { type: 'usage', usage });
          if (wake.transcript) await emit(turn.id, { type: 'diagnostic', native: { schema: BOOTED_EVIDENCE_SCHEMA, transcript: wake.transcript } });
          const status = wake.state === 'completed' ? 'completed' : wake.state === 'stopped' ? 'cancelled' : 'failed';
          return {
            status, text: wake.text, usage,
            evidence: { adapterId: BOOTED_ADAPTER_ID, payload: { schema: BOOTED_EVIDENCE_SCHEMA, acceptanceId: wake.acceptanceId,
              executionId: wake.executionId, state: wake.state, code: wake.code } },
            coverage: [
              { channel: 'output', completeness: wake.state === 'completed' ? 'complete' : 'partial', ordering: 'none' },
              { channel: 'usage', completeness: usage === null ? 'absent' : wake.usage.every((row) => row.complete) ? 'complete' : 'partial', ordering: 'none' },
              { channel: 'tools', completeness: 'absent', ordering: 'none' },
            ],
            ...(status === 'completed' ? {} : { error: `trial wake ${wake.state}${wake.code ? ` (${wake.code})` : ''}` }),
          };
        },
      };
    },
  };
}
