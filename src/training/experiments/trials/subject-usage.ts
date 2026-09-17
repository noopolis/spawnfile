import type { SubjectUsageSnapshot } from '../../contracts/evaluation.js';
import type { SubjectTurnResult, Usage } from '../../contracts/execution.js';

const required = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const;
const optional = ['cacheWriteInputTokens', 'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens'] as const;
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Validate native totals before arithmetic; cache and reasoning are subsets, not extra tokens. */
function validUsage(usage: Usage): boolean {
  if (typeof usage.source !== 'string' || !usage.source.trim()) return false;
  if (required.some(key => usage[key] !== null && !validNumber(usage[key])) ||
    optional.some(key => usage[key] !== undefined && usage[key] !== null && !validNumber(usage[key]))) return false;
  if (usage.inputTokens !== null && usage.outputTokens !== null && !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) return false;
  if (usage.inputTokens !== null && usage.cachedInputTokens !== null && usage.cachedInputTokens > usage.inputTokens) return false;
  if (usage.outputTokens !== null && usage.reasoningTokens !== null && usage.reasoningTokens > usage.outputTokens) return false;
  if (usage.inputTokens !== null && usage.cacheWriteInputTokens != null &&
    (usage.cachedInputTokens ?? 0) + usage.cacheWriteInputTokens > usage.inputTokens) return false;
  if (usage.cacheWriteInputTokens != null && (usage.cacheWrite5mInputTokens ?? 0) + (usage.cacheWrite1hInputTokens ?? 0) > usage.cacheWriteInputTokens) return false;
  if (usage.notionalUsd != null && (typeof usage.notionalUsd !== 'number' || !Number.isFinite(usage.notionalUsd) || usage.notionalUsd < 0)) return false;
  return true;
}

/** Sum returned per-turn totals exactly once. Caller separately attests lifecycle closure. */
export function subjectUsageSnapshot(turns: readonly SubjectTurnResult[], options: {
  expectedTurns: number; complete: boolean;
}): SubjectUsageSnapshot {
  const missing: SubjectUsageSnapshot = { status: 'incomplete', usage: null };
  if (!turns.length || turns.some(turn => turn.usage === null || !validUsage(turn.usage))) return missing;
  const totals = turns.map(turn => turn.usage!);
  let usage: Usage;
  if (totals.length === 1) usage = structuredClone(totals[0]!);
  else {
    usage = { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, source: 'paideia.subject.returned-turn-totals.v1' };
    for (const key of [...required, ...optional]) {
      if (optional.includes(key as (typeof optional)[number]) && totals.every(row => row[key] === undefined)) continue;
      if (totals.some(row => row[key] == null)) { usage[key] = null; continue; }
      const total = totals.reduce((sum, row) => sum + row[key]!, 0);
      if (!Number.isSafeInteger(total)) return missing;
      usage[key] = total;
    }
    if (totals.some(row => row.notionalUsd !== undefined)) {
      usage.notionalUsd = totals.some(row => row.notionalUsd == null) ? null : totals.reduce((sum, row) => sum + row.notionalUsd!, 0);
    }
    if (!validUsage(usage)) return missing;
  }
  const complete = options.complete && options.expectedTurns > 0 && Number.isSafeInteger(options.expectedTurns) && turns.length === options.expectedTurns &&
    usage.inputTokens !== null && usage.outputTokens !== null && turns.every(turn => {
      const channels = turn.coverage.filter(row => row.channel === 'usage');
      return turn.status === 'completed' && channels.length > 0 && channels.every(row => row.completeness === 'complete') &&
        (!turn.stop || turn.stop.state === 'acknowledged' && turn.stop.quiescence === 'confirmed');
    });
  return { status: complete ? 'complete' : 'incomplete', usage };
}
