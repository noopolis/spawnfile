import { describe, expect, it, vi } from 'vitest';
import { runQuestionnaire } from './run.js';
import { testBank, testJudge, testMaterial, testReplies } from './testSupport.js';

const bank = testBank();

describe('questionnaire run', () => {
  it('asks one call per group in order and hands working on', async () => {
    const strong = testJudge(testReplies);
    const observe = vi.fn();
    const result = await runQuestionnaire({ bank, material: testMaterial, judges: { strong }, observe });
    expect(strong.prompts).toHaveLength(2);
    expect(strong.prompts[1]).toContain('fidelity.support:\nP1: E1');
    expect(result).toMatchObject({ bank: { id: 'test-bank', version: 1 }, gate: 'pass', errors: [], failedCalls: [], score: 0.6875, scoreOpen: 0.6667, scoreHidden: 0.75 });
    expect(result.answers.map(answer => [answer.id, answer.group, answer.status, answer.hidden, answer.gate, answer.weight]))
      .toEqual([['figures', 'fidelity', 'ok', false, true, 1], ['quotes', 'fidelity', 'na', true, false, 1], ['padding', 'house', 'ok', false, false, 2], ['unused', 'house', 'ok', true, false, 1]]);
    expect(result.scaffold).toEqual({ fidelity: { numbers_list: ['six, headline'], support: 'P1: E1' }, house: {} });
    expect(result.judgeCalls).toMatchObject([{ judge: 'strong', providerId: 'test-provider', requestedModel: 'judge-model', outcome: 'completed', responseModel: null, billing: 'subscription' }, { outcome: 'completed' }]);
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it('records a wrong, missing or malformed answer as an error', async () => {
    const strong = testJudge([{ numbers_list: { answer: 'not a list' }, figures: { answer: 'true', reason: 'x' }, quotes: 'no' }, { padding: { answer: 'clause' } }]);
    const result = await runQuestionnaire({ bank: testBank(), material: testMaterial, judges: { strong } });
    expect(result).toMatchObject({ gate: 'error', errors: ['figures', 'quotes', 'unused'] });
    expect(result.scaffold.fidelity).toEqual({ numbers_list: { error: 'extraction-list answer must be a list of strings' }, support: { error: 'missing answer' } });
    expect(strong.prompts[1]).not.toContain('EARLIER WORKING');
  });
  it('turns a failed call into errors for its group and still asks the next', async () => {
    const failure = Object.assign(new Error('down'), { kind: 'unavailable', responseRoute: 'r' });
    const strong = testJudge([failure, testReplies[1]]);
    const result = await runQuestionnaire({ bank, material: testMaterial, judges: { strong } });
    expect(result).toMatchObject({ gate: 'error', errors: ['figures', 'quotes'], failedCalls: [{ group: 'fidelity', repeat: 1, reason: 'judge call failed (unavailable)' }] });
    expect(result.judgeCalls[0]).toMatchObject({ outcome: 'generation-error', failureKind: 'unavailable', responseRoute: 'r' });
    expect(result.answers.find(answer => answer.id === 'padding')).toMatchObject({ status: 'ok' });
  });
  it.each([['not json', 'judge reply was not a JSON object'], ['[1]', 'judge reply was not a JSON object']])('refuses the reply %s', async (reply, reason) => {
    const result = await runQuestionnaire({ bank, material: testMaterial, judges: { strong: testJudge([reply, new Error('plain')]) } });
    expect(result.failedCalls).toEqual([{ group: 'fidelity', repeat: 1, reason }, { group: 'house', repeat: 1, reason: 'judge call failed' }]);
    expect(result.judgeCalls.map(call => call.outcome)).toEqual(['invalid-response', 'generation-error']);
  });
  it('refuses a missing route and a route on another effort without calling it', async () => {
    const missing = await runQuestionnaire({ bank, material: testMaterial, judges: {} });
    expect(missing).toMatchObject({ gate: 'error', judgeCalls: [], failedCalls: [{ reason: 'judge route strong is not configured' }, { group: 'house' }] });
    const low = testJudge(testReplies, 'low'), unset = testJudge(testReplies, null);
    expect((await runQuestionnaire({ bank, material: testMaterial, judges: { strong: low } })).failedCalls[0]!.reason).toBe('judge route strong runs effort low, the bank requires medium');
    expect((await runQuestionnaire({ bank, material: testMaterial, judges: { strong: unset } })).failedCalls[0]!.reason).toContain('effort unset');
    expect(low.prompts).toHaveLength(0);
  });
  it('repeats a group and combines its votes', async () => {
    const repeated = testBank();
    repeated.groups[0]!.repeats = 2;
    delete repeated.groups[0]!.effort;
    delete repeated.groups[1]!.effort;
    const first = testReplies[0]!, second = { ...first, figures: { answer: 'no', reason: 'P1 "seven"' } };
    const result = await runQuestionnaire({ bank: repeated, material: testMaterial, judges: { strong: testJudge([first, second, testReplies[1]], null) } });
    expect(result).toMatchObject({ gate: 'fail', gateFailures: ['figures'] });
    expect(result.answers[0]).toMatchObject({ answer: 'no', votes: ['yes', 'no'] });
    expect(result.judgeCalls).toHaveLength(3);
  });
  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runQuestionnaire({ bank, material: testMaterial, judges: { strong: testJudge(testReplies) }, signal: controller.signal })).rejects.toThrow();
    const late = new AbortController();
    const strong = testJudge([Object.assign(new Error('x'), { get kind() { late.abort(); return 'cancelled'; } })]);
    strong.provider.generate = async () => { late.abort(); throw new Error('aborted'); };
    await expect(runQuestionnaire({ bank, material: testMaterial, judges: { strong }, signal: late.signal })).rejects.toThrow();
  });
});
