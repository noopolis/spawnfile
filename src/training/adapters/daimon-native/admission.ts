import type { SubjectTurnResult } from '../../contracts/execution.js';
import type { TerminalEvidence } from './worker/index.js';

type Admission = NonNullable<SubjectTurnResult['admission']>;
export const unknownNativeAdmission = (): Admission => ({ executionRecords: null, executionsUsed: null, agentExecutionsUsed: null,
  tokensUsed: null, agentTokensUsed: null, toolEvents: null, outputEvents: null });
const count = (value: unknown): number | null => Array.isArray(value) ? value.length : null;
const counter = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

/** Called only after the adapter binds trial, wake, agent, model, config and transport source. */
export function nativeAdmission(value: TerminalEvidence): Admission {
  const receipt = value.receipt;
  const activity = value.activity;
  const availability = value.availability;
  const native = value.native;
  if (!receipt || receipt.version !== 'noopolis.daimon.wake-receipt-status.v2' || receipt.agent_id !== value.agentId ||
    typeof receipt.acceptance_id !== 'string' || receipt.acceptance_id.trim().length === 0 ||
    receipt.state !== 'accepted' || receipt.deferred || receipt.execution_id !== undefined ||
    receipt.delivery_id !== (value.transport?.deliveryId ?? `${value.trialId}:${value.wakeId}`) ||
    !activity || activity.version !== 'noopolis.daimon.organization-runtime-activity.v2' || !Array.isArray(activity.items) ||
    !activity.items.length || activity.items.some(item => !item || item.agent_id !== value.agentId ||
      item.delivery_id !== receipt.delivery_id || item.acceptance_id !== receipt.acceptance_id ||
      item.execution_id !== undefined || item.state !== 'accepted' || item.active !== false || item.deferred) ||
    availability?.version !== 'noopolis.daimon.work-availability.v1' || !Array.isArray(availability.agents) ||
    availability.agents.length !== 1 || availability.agents[0]?.agent_id !== value.agentId ||
    availability.agents[0].running !== false || !native) return unknownNativeAdmission();
  const budget = availability.agents[0].budget as Record<string, unknown> | null;
  if (!budget || budget.armed !== true || budget.epoch !== value.trialId) return unknownNativeAdmission();
  const records = [count(activity.executions), count(native.traces), count(native.usage), count(native.modelContexts),
    count(native.accounting?.usage), value.executionId === undefined ? 0 : 1,
    native.requests === undefined ? 0 : count(native.requests), native.turnSeals === undefined ? 0 : count(native.turnSeals)];
  if (value.transport) {
    const transport = value.transport;
    if (transport.acceptanceId !== receipt.acceptance_id || !Array.isArray(transport.selectedDeliveries) ||
      !transport.selectedDeliveries.length || transport.selectedDeliveries.some(row => !row ||
        row.deliveryId !== receipt.delivery_id || !Array.isArray(row.executionIds) || row.executionIds.length !== 0 ||
        row.receipt?.execution_id !== undefined || row.receipt?.agent_id !== value.agentId ||
        row.receipt?.delivery_id !== receipt.delivery_id || row.receipt?.acceptance_id !== receipt.acceptance_id ||
        row.receipt?.state !== 'accepted' || row.receipt?.deferred)) return unknownNativeAdmission();
    records.push(count(transport.batches), transport.batch === undefined ? 0 : 1);
  }
  const texts = [receipt.text, ...activity.items.map(item => item.text),
    ...(value.transport?.selectedDeliveries ?? []).map(row => row.receipt?.text)];
  return {
    executionRecords: records.includes(null) ? null : records.reduce<number>((sum, item) => sum + item!, 0),
    executionsUsed: counter(budget.executions_used), agentExecutionsUsed: counter(budget.agent_executions_used),
    tokensUsed: counter(budget.tokens_used), agentTokensUsed: counter(budget.agent_tokens_used),
    toolEvents: count(native.toolReceipts),
    outputEvents: texts.some(text => text !== undefined && typeof text !== 'string') ? null
      : texts.some(text => !!text) ? 1
      : value.coverage?.some(row => row.channel === 'output' && row.completeness === 'absent') ? 0 : null,
  };
}
