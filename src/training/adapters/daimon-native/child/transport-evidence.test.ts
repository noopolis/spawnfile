import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { bindTerminalEvidence } from './lifecycle.js';
import { launchFixture, traceFixture } from '../test-fixtures.js';
import type { TerminalEvidence, TransportDeliverySource } from '../worker/index.js';
import type { TerminalEvidenceMissing } from '../../../contracts/execution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = { kind: 'transport', deliveryId: 'moltnet:answer' } as const;

it('binds child evidence to the real delivery and the source requested for this wake', async () => {
  const fixture = await launchFixture(); roots.push(fixture.root); fixture.launch.delivery = 'transport';
  const trace = traceFixture();
  const frame = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId,
    status: 'completed',
    agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
    wakeId: 'answer', executionId: trace.turn_id, native: { traces: [trace] },
    receipt: { agent_id: fixture.launch.agent.id, delivery_id: source.deliveryId, acceptance_id: 'accepted', execution_id: trace.turn_id },
    transport: { source, deliveryId: source.deliveryId, acceptanceId: 'accepted',
      batch: { executionId: trace.turn_id, deliveryIds: [source.deliveryId, 'moltnet:batch-two'] } },
    activity: { executions: [] } } as unknown as TerminalEvidence;
  let sealed: TerminalEvidenceMissing | undefined;
  const wake = { wakeId: 'answer', source: source as TransportDeliverySource, unevidenced: 'terminal-absent' as TerminalEvidenceMissing | undefined };
  bindTerminalEvidence(wake, frame, fixture.launch, fixture.input.trialId, fault => { sealed = fault; });
  expect(wake.unevidenced).toBeUndefined(); expect(sealed).toBeUndefined();
  const next = { ...wake, source: { kind: 'transport', deliveryId: 'moltnet:different' } as const };
  bindTerminalEvidence(next, frame, fixture.launch, fixture.input.trialId, fault => { sealed = fault; });
  expect(next.unevidenced).toBe('terminal-unbound'); expect(sealed).toBe('terminal-unbound');
  frame.receipt!.delivery_id = `${fixture.input.trialId}:answer`;
  bindTerminalEvidence(wake, frame, fixture.launch, fixture.input.trialId, fault => { sealed = fault; });
  expect(wake.unevidenced).toBe('terminal-unbound');
});

it.each(['absent', 'missed-batch', 'foreign-history', 'duplicate-history'] as const)('records %s without erasing admissible earlier wakes unless attribution conflicts', async kind => {
  const fixture = await launchFixture(); roots.push(fixture.root); fixture.launch.delivery = 'transport';
  const trace = traceFixture();
  const frame = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, status: 'failed',
    agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
    wakeId: 'answer', native: { traces: [trace] }, activity: { executions: [] }, transport: { source } } as unknown as TerminalEvidence;
  if (kind === 'missed-batch') {
    frame.receipt = { agent_id: fixture.launch.agent.id, delivery_id: source.deliveryId, acceptance_id: 'accepted' } as TerminalEvidence['receipt'];
    frame.executionId = trace.turn_id; frame.transport!.deliveryId = source.deliveryId; frame.transport!.acceptanceId = 'accepted';
  }
  if (kind === 'foreign-history') frame.native.traces[0]!.agent_id = 'foreign';
  if (kind === 'duplicate-history') frame.native.traces.push(trace);
  let sealed: TerminalEvidenceMissing | undefined;
  const wake = { wakeId: 'answer', source, unevidenced: undefined as TerminalEvidenceMissing | undefined };
  const bind = () => bindTerminalEvidence(wake, frame, fixture.launch, fixture.input.trialId, fault => { sealed = fault; });
  if (kind.endsWith('-history')) {
    expect(bind).toThrow(); expect(sealed).toBe(kind === 'duplicate-history' ? 'terminal-ambiguous' : 'terminal-unbound');
  } else { expect(bind).not.toThrow(); expect(sealed).toBeUndefined(); }
  expect(wake.unevidenced).toBe(kind === 'duplicate-history' ? 'terminal-ambiguous' : 'terminal-unbound');
});
