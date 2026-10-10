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
      outcome: 'generation-error', usage: null, failureKind: 'protocol' },
    // A recovered judgement stays recoverable-looking after replay: strip `retryOf` here
    // and a score from a second attempt reads exactly like one that answered first time.
    { ...call, outcome: 'completed', retryOf: 'actual-generation', retryCause: 'provider-error' }];
  });
  expect(trialReportSchema.parse(report).evaluation.judgeCalls).toEqual(report.evaluation.judgeCalls);
  for (const malformed of [
    { ...call, id: '' },
    { ...call, retryOf: '' },
    { ...call, retryCause: 'grant-vaporised' },
    { ...call, outcome: 'invented' },
    { ...call, usage: { ...usage, cacheWriteInputTokens: -1 } },
    { ...call, responseModel: 42 },
  ]) {
    expect(() => trialReportSchema.parse({ ...report,
      evaluation: { ...report.evaluation, judgeCalls: [malformed] } })).toThrow();
  }
});

/**
 * The closure cause has to survive being read back. This schema strips what it
 * does not declare, so an undeclared `stop.unconfirmed` would put an operator
 * back where they were before the vocabulary existed: a replayed report that
 * says a trial was unscorable and not which proof was missing.
 */
test('a replayed report keeps which closure proof failed', async () => {
  const { report } = await fixture();
  report.stop = { state: 'unknown', scope: 'native-handle', quiescence: 'unknown', remoteWork: 'unknown',
    reason: 'External input delivery budget exhausted', unconfirmed: 'native-stop-unacknowledged',
    detail: 'Native child closure unconfirmed (native-stop-unacknowledged); caller must stop the shared container' };
  expect(trialReportSchema.parse(JSON.parse(JSON.stringify(report))).stop).toMatchObject({ unconfirmed: 'native-stop-unacknowledged' });
  // Only the closed vocabulary parses; an invented cause is refused, not carried.
  expect(() => trialReportSchema.parse(JSON.parse(JSON.stringify({ ...report, stop: { ...report.stop, unconfirmed: 'made-up' } })))).toThrow();
});

/**
 * The same argument for the judge: a replayed report that says `error` and not
 * which judge refused, expired or answered unreadably is the anonymous failure
 * coming straight back through the schema that was meant to preserve it.
 */
test('a replayed report keeps why a judge errored', async () => {
  const { report } = await fixture();
  const failure = { cause: 'grant-refused' as const, judge: 'grounding', providerId: 'grok-broker-grant',
    requestedModel: 'grok-4.6', responseModel: null, responseRoute: null, kind: 'unavailable' as const };
  const stage = report.evaluation.stages[0]!;
  stage.checks.push({ id: 'grounding', status: 'error', finality: 'final', reason: 'Routed inference stopped (unavailable)',
    evidence: [], judgeFailure: failure });
  const parsed = trialReportSchema.parse(JSON.parse(JSON.stringify(report)));
  expect(parsed.evaluation.stages[0]!.checks.at(-1)!.judgeFailure).toEqual(failure);
  // Only the closed vocabulary parses; an invented cause is refused, not carried.
  stage.checks.at(-1)!.judgeFailure = { ...failure, cause: 'grant-vaporised' as never };
  expect(() => trialReportSchema.parse(JSON.parse(JSON.stringify(report)))).toThrow();
});
