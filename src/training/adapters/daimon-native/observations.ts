import type { NativeExternalInput } from './external.js';
import type { Observation, SubjectStart, Usage } from '../../contracts/execution.js';
import { readToolReceipts } from './worker/index.js';
import type { NativeUsage, TerminalEvidence } from './worker/index.js';

export function createNativeObserver(input: SubjectStart, runtimeHome: string, agentId: string) {
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
      for (const row of await readToolReceipts(runtimeHome, agentId)) {
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
  const sum = (key: 'input' | 'output' | 'cache_read'): number => {
    const value = rows.reduce((total, row) => total + row[key], 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Native token aggregate is invalid');
    return value;
  };
  return { inputTokens: sum('input'), cachedInputTokens: sum('cache_read'), outputTokens: sum('output'),
    reasoningTokens: null, source: 'noopolis.daimon.turn-usage.v1' };
}
