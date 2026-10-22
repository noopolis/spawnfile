import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { admittedNativeEvidence } from './outcome.js';
import { createDaimonNativeAdapter } from './index.js';
import { runTrial } from '../../experiments/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { dockerFixture, activityFixture, launchFixture, receiptFixture, traceFixture, unadmittedFixture } from './test-fixtures.js';

it('publishes only bound evidence and refuses foreign activity or delivery attribution', async () => {
  const f = await launchFixture();
  try {
    const trialId = '11111111-1111-4111-8111-111111111111';
    const frame = { ...unadmittedFixture(trialId), status: 'completed' as const,
      model: f.launch.agent.model, configSha256: f.launch.configSha256, executionId: traceFixture().turn_id,
      receipt: { ...receiptFixture(), delivery_id: `${trialId}:task` }, activity: activityFixture() };
    frame.activity.items[0]!.delivery_id = frame.receipt.delivery_id;
    frame.native.traces = [traceFixture()];
    const admit = () => admittedNativeEvidence(frame, f.launch, trialId, 'task', 1, '/control/evidence.json', undefined, new Set());
    expect(admit()?.executionIds).toEqual([frame.executionId]);
    expect(admittedNativeEvidence({ ...frame, activity: undefined }, f.launch, trialId, 'task', 1, '/evidence.json', undefined, new Set())).toBeUndefined();
    expect(admittedNativeEvidence({ ...frame, receipt: undefined }, f.launch, trialId, 'task', 1, '/evidence.json', undefined, new Set())).toBeUndefined();
    frame.activity.items.push({ ...frame.activity.items[0]!, delivery_id: 'native-tool-receipt', execution_id: 'unrelated' });
    expect(admit()?.executionIds).toEqual([frame.executionId]);
    frame.activity.items[1]!.agent_id = 'foreign';
    expect(admit).toThrow('activity evidence identity');
    frame.activity.items[1]!.agent_id = f.launch.agent.id;
    frame.activity.items[1]!.delivery_id = '22222222-2222-4222-8222-222222222222:task';
    expect(admit).toThrow('activity delivery identity');
    frame.activity.items.pop();
    frame.native.accounting = { coverage: 'complete', usage: [{
      v: 'noopolis.daimon.turn-usage.v1', agent: f.launch.agent.id, wake: 'revisit', engine: 'codex',
      input: 1, output: 1, cache_read: 0, total: 2, complete: true,
    }] };
    expect(admit()?.executionIds).toEqual([frame.executionId, 'revisit']);
    frame.native.accounting.usage[0]!.agent = 'foreign';
    expect(admit).toThrow('accounting evidence identity');
    frame.native.accounting.usage[0]!.agent = f.launch.agent.id;
    frame.native.accounting.usage[0]!.wake = '';
    expect(admit).toThrow('accounting evidence identity');
    delete frame.native.accounting;

    f.launch.delivery = 'transport';
    const source = { kind: 'transport' as const, deliveryId: 'moltnet:current' };
    const transportFrame = { ...frame, receipt: { ...frame.receipt, delivery_id: source.deliveryId },
      transport: { source, deliveryId: source.deliveryId, acceptanceId: frame.receipt.acceptance_id,
        batch: { executionId: frame.executionId, deliveryIds: [source.deliveryId], observedAt: frame.completedAt },
        deliveries: [], deferredDeliveryIds: [], unresolvedDeliveryIds: [], renderedAllowances: 'unavailable-public-api' as const } };
    transportFrame.activity.items = [
      { ...transportFrame.receipt, active: false },
      { ...transportFrame.receipt, active: false, delivery_id: 'moltnet:earlier', execution_id: 'prior-execution' },
      { ...transportFrame.receipt, active: false, delivery_id: 'native-tool', execution_id: '' },
    ];
    const admitTransport = () => admittedNativeEvidence(transportFrame, f.launch, trialId, 'task', 2,
      '/control/evidence.json', source, new Set(['moltnet:earlier']));
    expect(admitTransport()?.executionIds).toEqual([frame.executionId, 'prior-execution']);
    transportFrame.activity.items[1]!.delivery_id = 'moltnet:foreign';
    expect(admitTransport).toThrow('activity delivery identity');
    delete f.launch.delivery;

    frame.executionId = 'not-a-closed-execution'; delete frame.receipt.execution_id;
    expect(admit()).toBeUndefined();
    frame.trialId = 'foreign';
    expect(admit).toThrow('attribution conflict');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it.each([false, true])('collect receives exactly adapter-admitted IDs; foreign frame: %s', async foreign => {
  const f = await launchFixture();
  try {
    const frame = { ...unadmittedFixture(f.input.trialId), status: 'completed' as const,
      trialId: foreign ? 'foreign' : f.input.trialId,
      model: f.launch.agent.model, configSha256: f.launch.configSha256, executionId: traceFixture().turn_id,
      receipt: { ...receiptFixture(), delivery_id: `${f.input.trialId}:task` }, activity: activityFixture() };
    frame.activity.items[0]!.delivery_id = frame.receipt.delivery_id;
    frame.native.traces = [traceFixture()];
    const docker = dockerFixture(f.launch, f.input.trialId); docker.setTerminal(frame);
    const native = createDaimonNativeAdapter({ docker: docker.run });
    const record = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: outcome
checks:
  - {id: empty, eval: equals, input: output.text, value: ""}
records:
  - {id: record, group: unique, input: {prompt: work}}
`)).records[0]!;
    const collected: unknown[] = [];
    await runTrial({ id: f.input.trialId, phase: 'train', record, candidateId: 'candidate', datasetDigest: 'dataset',
      planDigest: 'plan', root: `${f.root}/trial`, model: f.launch.agent.model, timeoutMs: 5000,
      adapter: { ...native, start: input => native.start({ ...f.input, onObservation: input.onObservation, signal: input.signal }) },
      prepare: async () => ({ instructions: f.input.instructions, collect: async outcome => {
        if (outcome) collected.push(outcome.turns.map(turn => turn.native.evidence));
        return {};
      } }), registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' }, persist: async () => undefined });
    expect(collected.length).toBeGreaterThan(0);
    if (foreign) expect(collected.every(value => Array.isArray(value) && value.length === 1 && value[0] === undefined)).toBe(true);
    else expect(collected.at(-1)).toEqual([{ adapterId: 'daimon-native', payload: {
      schema: 'paideia.daimon-native.evidence.v1', wakes: [{ wakeId: 'task', executionId: frame.executionId,
        executionIds: [frame.executionId], evidenceFile: `${f.launch.controlRoot}/evidence.1.json` }],
    } }]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it.each(['identity', 'sealed', 'missing-execution', 'missing-execution-foreign-activity'] as const)(
  'collect receives exact session evidence after a %s continuation', async kind => {
    const f = await launchFixture();
    try {
      const first = { ...unadmittedFixture(f.input.trialId), status: 'failed' as const,
        blocked: 'awaiting-external-input' as const,
        model: f.launch.agent.model, configSha256: f.launch.configSha256, executionId: traceFixture().turn_id,
        receipt: { ...receiptFixture(), delivery_id: `${f.input.trialId}:task` }, activity: activityFixture() };
      first.activity.items[0]!.delivery_id = first.receipt.delivery_id;
      first.native.traces = [traceFixture()];
      const next = structuredClone(first);
      next.wakeId = 'answer'; next.receipt.delivery_id = `${f.input.trialId}:answer`;
      next.activity.items[0]!.delivery_id = next.receipt.delivery_id;
      if (kind === 'identity') next.configSha256 = 'foreign';
      // A sealed conflict returns normally from binding (unlike a foreign trace).
      if (kind === 'sealed') next.receipt.delivery_id = 'foreign:answer';
      if (kind.startsWith('missing-execution')) { next.executionId = 'missing'; delete next.receipt.execution_id; }
      if (kind === 'missing-execution-foreign-activity') next.activity.items[0]!.agent_id = 'foreign';
      const docker = dockerFixture(f.launch, f.input.trialId); docker.setTerminal(first);
      let deliveries = 0;
      const native = createDaimonNativeAdapter({ docker: async (args, options) => {
        if (args[0] === 'exec' && JSON.parse(options?.stdin ?? '{}').path === '/trial/run') deliveries++;
        return docker.run(args, options);
      }, externalInputs: { maxDeliveries: 1,
        next: async () => { docker.setTerminal(next); return { id: 'answer', text: 'reply',
          source: { kind: 'transport', id: 'answer', sha256: `sha256:${createHash('sha256').update('reply').digest('hex')}` } }; } } });
      const record = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: continuation
checks:
  - {id: empty, eval: equals, input: output.text, value: ""}
records:
  - {id: record, group: unique, input: {prompt: work}}
`)).records[0]!;
      const collected: unknown[] = [];
      await runTrial({ id: f.input.trialId, phase: 'train', record, candidateId: 'candidate', datasetDigest: 'dataset',
        planDigest: 'plan', root: `${f.root}/trial`, model: f.launch.agent.model, timeoutMs: 5000,
        adapter: { ...native, start: input => native.start({ ...f.input, onObservation: input.onObservation, signal: input.signal }) },
        prepare: async () => ({ instructions: f.input.instructions, collect: async outcome => {
          if (outcome) collected.push(outcome.turns.map(turn => turn.native.evidence));
          return {};
        } }), registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
        persist: async () => undefined });
      expect(deliveries).toBe(2);
      expect(collected.length).toBeGreaterThan(0);
      const expected = kind === 'missing-execution' ? [{ adapterId: 'daimon-native', payload: {
        schema: 'paideia.daimon-native.evidence.v1', wakes: [{ wakeId: 'task', executionId: first.executionId,
          executionIds: [first.executionId], evidenceFile: `${f.launch.controlRoot}/evidence.1.json` }],
      } }] : [undefined];
      expect(collected).toEqual(collected.map(() => expected));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
