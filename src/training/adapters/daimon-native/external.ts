import type { ObservationCoverage, Usage } from '../../contracts/execution.js';
import type { NativeLaunch } from './receipt/index.js';
import { verifyExternalSource, type ExternalInputSource, type TerminalEvidence } from './worker/index.js';
import { verifyPreparedTransport, type PreparedTransportDelivery } from './transport/index.js';

export interface NativeExternalInput { id: string; text: string; source: ExternalInputSource; transport?: PreparedTransportDelivery }
export interface NativeExternalInputs {
  maxDeliveries: number;
  next(context: { trialId: string; turnId: string; containerName: string; launch: NativeLaunch; terminal: TerminalEvidence },
    signal: AbortSignal): Promise<NativeExternalInput | null>;
}

export interface NativeChildExternalInputs {
  maxDeliveries: number;
  next(context: { trialId: string; turnId: string; executionId: string; launch: NativeLaunch; terminal: TerminalEvidence },
    signal: AbortSignal): Promise<NativeExternalInput | null>;
}

/** A callback may supply evidence; it cannot extend the task deadline or invent a retry. */
export async function nextExternalInput<T>(policy: { next(context: T, signal: AbortSignal): Promise<NativeExternalInput | null> }, context: T,
  deadline: number, signal: AbortSignal): Promise<NativeExternalInput | null> {
  if (signal.aborted) throw new Error('External input cancelled');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Native trial deadline exceeded awaiting external input');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new Error('External input cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error('Native trial deadline exceeded awaiting external input')); }, remaining);
  });
  try {
    const input = await Promise.race([policy.next(context, controller.signal), interrupted]);
    if (signal.aborted) throw new Error('External input cancelled');
    if (input !== null) {
      const keys = Object.keys(input).sort().join(',');
      if ((keys !== 'id,source,text' && keys !== 'id,source,text,transport') ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.id) || !input.text.trim() || Buffer.byteLength(input.text) > 16384) throw new Error('Invalid external input');
      verifyExternalSource(input.source, input.text);
      if (keys.endsWith(',transport')) verifyPreparedTransport(input.transport!, true);
    }
    return input;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
}

export function sumNativeUsage(rows: readonly (Usage | null)[]): Usage | null {
  if (!rows.length || rows.some(row => row === null)) return null;
  const sum = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens') => {
    const values = rows.map(row => row![key]);
    if (values.some(value => value === null)) return null;
    const total = values.reduce<number>((sum, value) => sum + value!, 0);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid aggregate native usage');
    return total;
  };
  const totals = { inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens') };
  // Optional members appear only when a wake reported them, so Codex aggregates keep their exact shape.
  const extra: Partial<Usage> = {};
  if (rows.some(row => row!.cacheWriteInputTokens !== undefined)) extra.cacheWriteInputTokens = rows.some(row => row!.cacheWriteInputTokens == null) ? null
    : rows.reduce((total, row) => total + row!.cacheWriteInputTokens!, 0);
  if (rows.some(row => row!.notionalUsd !== undefined)) extra.notionalUsd = rows.some(row => row!.notionalUsd == null) ? null
    : rows.reduce((total, row) => total + row!.notionalUsd!, 0);
  return rows.length === 1 ? { ...rows[0]!, ...totals }
    : { ...totals, ...extra, reasoningTokens: null, source: 'noopolis.daimon.turn-usage.v1' };
}


/** Missing coverage in any wake cannot be repaired by a later complete wake. */
export function weakestNativeCoverage(rows: readonly (readonly ObservationCoverage[] | undefined)[]): ObservationCoverage[] {
  const channels = new Set(rows.flatMap(row => row?.map(item => item.channel) ?? []));
  return [...channels].map(channel => {
    const values = rows.map(row => row?.find(item => item.channel === channel));
    const completeness = values.some(value => !value || value.completeness === 'absent') ? 'absent'
      : values.some(value => value?.completeness === 'partial') ? 'partial' : 'complete';
    const ordering = values.every(value => value?.ordering === 'causal') ? 'causal'
      : values.every(value => value && value.ordering !== 'none') ? 'source' : 'none';
    return { channel, completeness, ordering };
  });
}
