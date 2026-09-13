import { expect, test } from 'vitest';
import type { JudgeCall } from '../../contracts/evaluation.js';
import type { Usage } from '../../contracts/execution.js';
import { fixture } from './fixture.js';
import { trialReportSchema } from './schema.js';

const usage: Usage = { inputTokens: 40, cachedInputTokens: 10, cacheWriteInputTokens: 6,
  cacheWrite5mInputTokens: 2, cacheWrite1hInputTokens: 4,
  outputTokens: 8, reasoningTokens: null, source: 'native' };
const call: JudgeCall = { id: 'actual-generation', judge: 'editor', providerId: 'selected-provider',
  requestedModel: 'requested-alias', responseModel: 'reported-model', responseRoute: 'reported-route',
  outcome: 'invalid-response', usage };

test('replay retains judge attribution and cache-write usage across stored report surfaces', async () => {
  const { report } = await fixture(report => {
    const judged = { ...report.evaluation.checks.old!, usage: [usage], judgeCalls: [call] };
    report.evaluation.judgeCalls = [call];
    report.evaluation.checks.old = judged;
    report.evaluation.stages[0]!.checks = [judged];
    report.evaluation.stages[0]!.gate = judged;
    report.turns[0]!.native.usage = usage;
    report.turns[0]!.checks = [judged];
    report.live = [{ checkId: 'editor', boundary: 'event', result: judged }];
  });
  expect(trialReportSchema.parse(report)).toEqual(report);
});

test('replay preserves explicit unknown judge evidence and rejects invalid measured metadata', async () => {
  const { report } = await fixture(report => {
    report.evaluation.judgeCalls = [{ ...call, responseModel: null, responseRoute: null,
      outcome: 'generation-error', usage: null }];
  });
  expect(trialReportSchema.parse(report).evaluation.judgeCalls).toEqual(report.evaluation.judgeCalls);
  for (const malformed of [
    { ...call, id: '' },
    { ...call, outcome: 'invented' },
    { ...call, usage: { ...usage, cacheWriteInputTokens: -1 } },
    { ...call, responseModel: 42 },
  ]) {
    expect(() => trialReportSchema.parse({ ...report,
      evaluation: { ...report.evaluation, judgeCalls: [malformed] } })).toThrow();
  }
});
