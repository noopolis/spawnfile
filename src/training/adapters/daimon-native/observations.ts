import type { NativeExternalInput } from './external.js';
import type { Observation, SubjectStart, Usage } from '../../contracts/execution.js';
import { plausibleNotionalUsd, readToolReceipts } from './worker/index.js';
import type { NativeGrokUsage, NativeUsage, TerminalEvidence } from './worker/index.js';

export function createNativeObserver(input: SubjectStart, runtimeHome: string, agentId: string, engine: 'codex' | 'grok' = 'codex') {
  let seq = 0;
  const seen = new Set<string>();
  const emit = async (wakeId: string, value: Omit<Observation, 'id' | 'source' | 'seq' | 'timestamp' | 'trialId' | 'wakeId'>,
    timestamp = new Date().toISOString()): Promise<void> => {
    seq++;
    await input.onObservation({ id: `${input.trialId}:native:${seq}`, source: 'daimon.native-evidence', seq,
      timestamp, trialId: input.trialId, wakeId, ...value });
  };
  return {
    async externalInput(wakeId: string, value: NativeExternalInput): Promise<void> {
      await emit(wakeId, { type: 'input', text: value.text, native: { schema: 'paideia.external-input.v1', deliveryId: value.id, source: value.source } });
    },
    async checkpoint(wakeId: string): Promise<void> {
      for (const row of await readToolReceipts(runtimeHome, agentId, engine)) {
        const callId = String(row.delivery_id);
        if (seen.has(callId)) continue;
        seen.add(callId);
        await emit(wakeId, { type: 'tool.complete', callId,
          tool: row.kind === 'moltnet' ? 'moltnet_send' : `mcp_${String(row.server)}_${String(row.tool)}`,
          result: row.kind === 'moltnet' ? { message_id: row.message_id } : row.result ?? row.error,
          success: row.kind === 'moltnet' || row.is_error === false, native: row }, String(row.at));
      }
    },
    async terminal(wakeId: string, result: TerminalEvidence): Promise<Usage | null> {
      const usage = aggregateUsage(result.native.usage);
      if (usage) await emit(wakeId, { type: 'usage', usage, native: result.native.usage }, result.completedAt);
      await emit(wakeId, { type: 'diagnostic', text: `Native execution ${result.status}`, native: result }, result.completedAt);
      return usage;
    },
  };
}

export function aggregateUsage(rows: NativeUsage[]): Usage | null {
  if (!rows.length) return null;
  const sum = (values: number[]): number => {
    const value = values.reduce((total, item) => total + item, 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Native token aggregate is invalid');
    return value;
  };
  const grok = rows.filter((row): row is NativeGrokUsage => row.engine === 'grok');
  if (!grok.length) {
    return { inputTokens: sum(rows.map(row => row.input)), cachedInputTokens: sum(rows.map(row => row.cache_read)), outputTokens: sum(rows.map(row => row.output)),
      reasoningTokens: null, source: 'noopolis.daimon.turn-usage.v1' };
  }
  if (grok.length !== rows.length) throw new Error('Native usage mixes engines');
  // Grok buckets are disjoint; Paideia's inputTokens counts every prompt-side token, with reads and writes as subsets.
  if (!grok.every(row => plausibleNotionalUsd(row.notional_usd))) throw new Error('Native notional USD is outside its per-turn plausibility bound');
  const notionalUsd = grok.reduce((total, row) => total + row.notional_usd, 0);
  return { inputTokens: sum(grok.flatMap(row => [row.input, row.cache_read, row.cache_write])), cachedInputTokens: sum(grok.map(row => row.cache_read)),
    cacheWriteInputTokens: sum(grok.map(row => row.cache_write)), outputTokens: sum(grok.map(row => row.output)), reasoningTokens: null,
    notionalUsd, source: 'noopolis.daimon.turn-usage.v1' };
}
