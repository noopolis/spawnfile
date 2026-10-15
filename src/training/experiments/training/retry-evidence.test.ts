import { expect, it, vi } from 'vitest';
import type { Usage } from '../../contracts/execution.js';
import { artifact, observation, snapshot } from '../../testing/index.js';
import type { TrialReport } from '../trials/index.js';
import { retryTrial } from './retry.js';

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
