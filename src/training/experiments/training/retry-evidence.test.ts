import { expect, it, vi } from 'vitest';
import type { Usage } from '../../contracts/execution.js';
import { artifact, observation, snapshot } from '../../testing/index.js';
import type { TrialReport } from '../trials/index.js';
import { retryTrial } from './retry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTrial } from '../trials/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';

const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, source: 'native' };
function historicalReport(): TrialReport {
  return {
    schema: 'paideia.trial.v1', id: 'old', phase: 'train', candidateId: 'candidate', datasetDigest: 'dataset',
    planDigest: 'plan', recordId: 'record', paths: { root: '', workspace: '', control: '', runtimeHome: '' },
    execution: 'failed', failureKind: 'native-infrastructure', status: 'error', hostWork: 'settled',
    snapshot: snapshot({ events: [], output: '', artifacts: {} }), turns: [], live: [],
    evaluation: { status: 'error', stages: [], checks: {}, scores: {} },
    stop: { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown',
      reason: 'Native work ended', detail: 'closed' },
  };
}

it.each(['tool.dispatch', 'tool.complete', 'output-event', 'usage-event', 'output', 'artifact', 'usage',
  'completed', 'deferred', 'turn-output', 'turn-usage', 'decisive', 'interrupted'])(
  'vetoes historical infrastructure labels using retained %s evidence without mutation', async kind => {
    const report = historicalReport();
    if (['tool.dispatch', 'tool.complete', 'output-event', 'usage-event'].includes(kind)) {
      const type = kind === 'output-event' ? 'output' : kind === 'usage-event' ? 'usage' : kind as 'tool.dispatch' | 'tool.complete';
      report.snapshot.events = [observation({ type, text: type === 'output' ? 'Filed' : undefined })];
    }
    if (kind === 'output') report.snapshot.output = 'Filed';
    if (kind === 'artifact') report.snapshot.artifacts = { filing: artifact('Filed') };
    if (kind === 'usage') report.snapshot.subjectUsage = { status: 'incomplete', usage };
    if (['completed', 'deferred', 'turn-output', 'turn-usage'].includes(kind)) report.turns = [{
      id: 'wake', checks: [], native: { status: kind === 'completed' ? 'completed' : 'failed',
        ...(kind === 'deferred' ? { blocked: 'awaiting-external-input' as const } : {}),
        text: kind === 'turn-output' ? 'Filed' : '', usage: kind === 'turn-usage' ? usage : null, coverage: [] },
    }];
    if (kind === 'decisive') report.decisiveFailure = { status: 'fail', finality: 'final', evidence: [], reason: 'Selected mechanical failure' };
    if (kind === 'interrupted') report.execution = 'interrupted';
    const before = structuredClone(report);
    const execute = vi.fn().mockResolvedValue(report);
    expect(await retryTrial({ key: 'historical', maximum: 3, execute })).toBe(report);
    expect(execute).toHaveBeenCalledOnce();
    expect(report).toEqual(before);
  });

it('still replaces a closed never-acting failure with only diagnostics and empty artifacts/output', async () => {
  const report = historicalReport();
  report.snapshot.events = [observation({ type: 'diagnostic' }), observation({ id: 'empty', seq: 2, type: 'output', text: '' })];
  report.snapshot.artifacts = { empty: { ...artifact(), bytes: '' } };
  report.snapshot.subjectUsage = { status: 'incomplete', usage: null };
  report.turns = [{ id: 'wake', checks: [], native: { status: 'failed', text: '', usage: null, coverage: [] } }];
  const replacement = { ...historicalReport(), id: 'new', execution: 'completed' as const };
  const execute = vi.fn().mockResolvedValueOnce(report).mockResolvedValueOnce(replacement);
  expect(await retryTrial({ key: 'historical', maximum: 1, execute })).toBe(replacement);
  expect(execute).toHaveBeenCalledTimes(2);
});

function unadmittedReport(): TrialReport {
  const report = historicalReport(); report.collectionFailed = true;
  report.error = 'Final collection failed: executionId is absent';
  report.turns = [{ id: 'task', checks: [], native: { status: 'failed', text: '', usage: null, coverage: [],
    admission: { executionRecords: 0, executionsUsed: 0, agentExecutionsUsed: 0, tokensUsed: 0,
      agentTokensUsed: 0, toolEvents: 0, outputEvents: 0 } } }];
  return report;
}
it('retries a proven unadmitted collection failure up to the configured replacement budget', async () => {
  const first = unadmittedReport(); const second = { ...unadmittedReport(), id: 'second' };
  const completed = { ...historicalReport(), id: 'completed', execution: 'completed' as const };
  const execute = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(completed);
  expect(await retryTrial({ key: 'validation', maximum: 2, execute })).toBe(completed);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls[1]).toEqual(['trial-retry:["validation",1]', {
    failedTrialId: 'old', cause: first.error, attempt: 1 }]);
  expect(execute.mock.calls[2]![1]).toMatchObject({ failedTrialId: 'second', attempt: 2 });
});

it('replaces and reruns a validation trial through actual lifecycle collection and closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-unadmitted-retry-'));
  try {
    const record = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: retry
checks: [{id: answer, eval: equals, input: output.text, value: DONE}]
records: [{id: task, input: {prompt: work}}]
`)).records[0]!;
    const reports: TrialReport[] = []; let runs = 0;
    const completed = await retryTrial({ key: 'validation', maximum: 2, execute: async () => {
      const neverAdmitted = reports.length === 0;
      const report = await runTrial({ id: `attempt-${reports.length}`, phase: 'validation', record, candidateId: 'candidate',
        datasetDigest: 'dataset', planDigest: 'plan', model: 'test', root, timeoutMs: 1000,
        adapter: { id: 'admission-facade', capabilities: { toolTrace: 'partial', liveObservations: true,
          cancellation: 'native-handle', multiTurn: false, resources: ['instructions'], isolation: 'unit',
          readIsolation: 'declared-paths', protectedPaths: true }, start: async () => ({
            run: async () => { runs++; return neverAdmitted ? unadmittedReport().turns[0]!.native
              : { status: 'completed', text: 'DONE', usage: null,
                coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] }; },
            stop: async () => historicalReport().stop!,
          }) },
        prepare: async () => ({ instructions: 'work', collect: async () => {
          if (neverAdmitted) throw new Error('Terminal evidence missing executionId'); return {};
        } }), registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
        persist: async () => undefined });
      reports.push(report); return report;
    } });
    expect(runs).toBe(2);
    expect(reports[0]).toMatchObject({ phase: 'validation', execution: 'failed', failureKind: 'native-infrastructure', collectionFailed: true });
    expect(completed).toMatchObject({ phase: 'validation', execution: 'completed', status: 'pass' });
    expect(completed.paths.workspace).not.toBe(reports[0]!.paths.workspace);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each(['valid', 'missing', 'empty-turns', 'tool-event', 'output-event',
  'executionRecords', 'executionsUsed', 'agentExecutionsUsed', 'tokensUsed', 'agentTokensUsed', 'toolEvents', 'outputEvents'] as const)(
  're-derives replacement eligibility on resume from %s evidence', async kind => {
    const report = JSON.parse(JSON.stringify(unadmittedReport())) as TrialReport;
    const native = report.turns[0]!.native;
    if (kind === 'missing') delete native.admission;
    else if (kind === 'empty-turns') report.turns = [];
    else if (kind === 'tool-event' || kind === 'output-event') report.snapshot.events = [observation({
      type: kind === 'tool-event' ? 'tool.dispatch' : 'output', text: kind === 'output-event' ? 'Filed' : undefined })];
    else if (kind !== 'valid') native.admission![kind] = kind === 'agentTokensUsed' ? null : 1;
    const before = structuredClone(report);
    const completed = { ...historicalReport(), execution: 'completed' as const };
    const execute = vi.fn().mockResolvedValueOnce(report).mockResolvedValue(completed);
    expect(await retryTrial({ key: 'resumed', maximum: 2, execute })).toBe(kind === 'valid' ? completed : report);
    expect(execute).toHaveBeenCalledTimes(kind === 'valid' ? 2 : 1);
    expect(report).toEqual(before);
  });
