import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { runTrial, type TrialReport } from '../../experiments/index.js';
import { createDaimonNativeAdapter } from './index.js';
import { dockerFixture, launchFixture, unadmittedFixture } from './test-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const record = () => resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: admission
checks: [{id: done, eval: equals, input: output.text, value: DONE}]
records: [{id: task, input: {prompt: work}}]
`)).records[0]!;

it.each(['none', 'transport', 'missing-acceptance', 'transport-missing-acceptance', 'tool', 'output', 'ambiguous', 'ambiguous-collected', 'execution', 'operator', 'deadline'] as const)(
  'classifies the binding collection refusal using terminal admission evidence: %s', async kind => {
    let attempts = 0;
    const reports: TrialReport[] = [];
    const controller = new AbortController();
    const execute = async () => {
      attempts++;
      const f = await launchFixture(); roots.push(f.root);
      f.input.trialId = `trial-${attempts}`;
      const frame = unadmittedFixture(f.input.trialId);
      frame.configSha256 = f.launch.configSha256;
      if (kind === 'transport' || kind === 'transport-missing-acceptance') {
        f.launch.delivery = 'transport'; await f.save();
        const receipt = frame.receipt!; receipt.delivery_id = 'moltnet:reserved';
        frame.activity!.items[0]!.delivery_id = receipt.delivery_id;
        frame.transport = { source: { kind: 'transport', deliveryId: receipt.delivery_id }, deliveryId: receipt.delivery_id,
          acceptanceId: receipt.acceptance_id, deliveries: [], renderedAllowances: 'unavailable-public-api',
          deferredDeliveryIds: [], unresolvedDeliveryIds: [receipt.delivery_id], batches: [],
          selectedDeliveries: [{ deliveryId: receipt.delivery_id, executionIds: [], receipt: { ...receipt } }] };
      }
      if (kind === 'missing-acceptance' || kind === 'transport-missing-acceptance') {
        const receipts = [frame.receipt!, ...frame.activity!.items, ...(frame.transport?.selectedDeliveries ?? []).map(row => row.receipt!)];
        for (const receipt of receipts) delete (receipt as Partial<typeof receipt>).acceptance_id;
        if (frame.transport) delete frame.transport.acceptanceId;
      }
      const docker = dockerFixture(f.launch, f.input.trialId);
      if (kind === 'ambiguous' || kind === 'ambiguous-collected') delete frame.activity!.executions;
      if (kind === 'execution') frame.native.traces = [{ schema: 'daimon.turn_trace.v1', agent_id: frame.agentId,
        turn_id: 'execution', started_at: frame.startedAt, completed_at: frame.completedAt, status: 'failed', tools: [] }];
      docker.setTerminal(frame);
      const native = createDaimonNativeAdapter({ docker: docker.run, ...(frame.transport ? { transportDelivery: {
        prepare: async () => ({ source: frame.transport!.source, publish: async () => undefined }),
      } } : {}) });
      const report = await runTrial({ id: f.input.trialId, phase: 'validation', candidateId: 'candidate', record: record(),
        datasetDigest: 'dataset', planDigest: 'plan', model: f.input.model!, root: f.root, timeoutMs: kind === 'deadline' ? 10 : 5000,
        signal: controller.signal, registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
        prepare: async () => ({ instructions: f.input.instructions, collect: async () => {
          if (kind === 'ambiguous-collected') return {};
          if (kind === 'operator') controller.abort();
          if (kind === 'deadline') await new Promise(resolve => setTimeout(resolve, 25));
          if (!frame.executionId) throw new Error('Native terminal evidence does not bind this trial to an admitted execution: executionId is absent');
          return {};
        } }),
        adapter: { ...native, start: async input => {
          const session = await native.start({ ...f.input, signal: input.signal, onObservation: input.onObservation });
          return { ...session, run: async (turn, signal) => {
            const result = await session.run(turn, signal);
            if (kind === 'tool' || kind === 'output') {
              // An observed action vetoes even an otherwise all-zero receipt.
              try { await input.onObservation({ id: 'acted', source: 'native', seq: 1,
                type: kind === 'tool' ? 'tool.dispatch' : 'output', text: kind === 'output' ? 'Filed' : undefined,
                trialId: input.trialId, wakeId: turn.id, timestamp: frame.completedAt }); } catch { /* final collection retains it */ }
            }
            return result;
          } };
        } }, persist: async () => undefined });
      reports.push(report); return report;
    };
    await execute();
    expect(attempts).toBe(1);
    expect(reports[0]).toMatchObject(kind === 'operator' || kind === 'deadline' ? { execution: 'interrupted' }
      : { execution: 'failed', failureKind: kind === 'none' || kind === 'transport' ? 'native-infrastructure' : 'measurement',
        ...(kind === 'ambiguous-collected' ? {} : { collectionFailed: true }) });
    if (kind === 'operator' || kind === 'deadline') expect(reports[0]).not.toHaveProperty('failureKind');
    if (kind !== 'ambiguous-collected') expect(reports[0]!.error).toContain('Final collection failed');
  });
