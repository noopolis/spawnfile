import { describe, expect, it } from 'vitest';
import { combineAnswers, judgeAnswer, parseAnswer, scoreAnswer, scoreQuestionnaire } from './answers.js';
import { bankQuestions } from './bank.js';
import { testBank } from './testSupport.js';
import type { AnswerRecord } from './types.js';

const bank = testBank();
const q = (id: string) => bankQuestions(bank).find(question => question.id === id)!;
const records = (answers: Record<string, unknown>): Record<string, AnswerRecord> =>
  Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, judgeAnswer(q(id), answer, 'why')]));

describe('questionnaire answers', () => {
  it('parses every declared type strictly', () => {
    expect(parseAnswer(q('figures'), ' YES ')).toEqual({ status: 'ok', value: 'yes' });
    expect(parseAnswer(q('padding'), 'Clause')).toEqual({ status: 'ok', value: 'clause' });
    expect(parseAnswer(q('unused'), '3')).toEqual({ status: 'ok', value: 3 });
    expect(parseAnswer(q('unused'), 2.5)).toEqual({ status: 'ok', value: 2.5 });
    expect(parseAnswer(q('quotes'), 'na')).toEqual({ status: 'na' });
    expect(parseAnswer(q('numbers_list'), ['a'])).toEqual({ status: 'ok', value: ['a'] });
    expect(parseAnswer(q('support'), ' notes ')).toEqual({ status: 'ok', value: 'notes' });
  });
  it.each([
    ['figures', undefined, 'missing'], ['figures', '', 'missing'], ['figures', true, 'not allowed'], ['figures', 'maybe', 'not yes or no'],
    ['figures', 'na', 'na is not allowed'], ['padding', 'lots', 'not one of the options'], ['unused', 'two', 'not a number'],
    ['unused', Number.NaN, 'not allowed'], ['numbers_list', 'a', 'list of strings'], ['numbers_list', [1], 'list of strings'], ['support', '  ', 'empty'],
  ])('records %s answered %j as an error', (id, raw, message) => {
    const parsed = parseAnswer(q(id as string), raw);
    expect(parsed).toMatchObject({ status: 'error' });
    expect((parsed as { error: string }).error).toContain(message);
  });
  it('scores by polarity, option, range and band', () => {
    expect([scoreAnswer(q('figures'), 'yes'), scoreAnswer(q('figures'), 'no'), scoreAnswer(q('quotes'), 'no')]).toEqual([1, 0, 1]);
    expect(scoreAnswer(q('padding'), 'clause')).toBe(0.5);
    expect([0, 1, 2, 3, 4].map(value => scoreAnswer(q('unused'), value))).toEqual([1, 1, 0.75, 0.75, 0]);
    const ranged = { ...q('unused'), bands: undefined, pass_when: { min: 1, max: 2 } };
    expect([0, 1, 2, 3].map(value => scoreAnswer(ranged, value))).toEqual([0, 1, 1, 0]);
    expect(scoreAnswer({ ...ranged, pass_when: {} }, 99)).toBe(1);
  });
  it('never lets a wrong or missing answer pass', () => {
    expect(judgeAnswer(q('figures'), 'true')).toMatchObject({ status: 'error', score: 0, passed: false, answer: 'true', reason: '' });
    expect(judgeAnswer(q('figures'), undefined, 7)).toMatchObject({ status: 'error', score: 0, passed: false, answer: null });
    expect(judgeAnswer(q('support'), '')).toMatchObject({ status: 'error', score: null, passed: null });
    expect(judgeAnswer(q('support'), 'ok')).toMatchObject({ status: 'ok', score: null, answer: 'ok' });
    expect(judgeAnswer(q('quotes'), 'na')).toMatchObject({ status: 'na', score: null, passed: null });
    expect(judgeAnswer(q('padding'), 'clause', 'P2')).toMatchObject({ status: 'ok', score: 0.5, passed: true, reason: 'P2' });
  });
  it('combines repeats', () => {
    const yes = judgeAnswer(q('figures'), 'yes'), no = judgeAnswer(q('figures'), 'no'), bad = judgeAnswer(q('figures'), '?');
    expect(combineAnswers(q('figures'), [yes], 'majority')).toBe(yes);
    expect(combineAnswers(q('figures'), [yes, yes, no], 'majority')).toMatchObject({ answer: 'yes', votes: ['yes', 'yes', 'no'] });
    expect(combineAnswers(q('figures'), [yes, no], 'majority')).toMatchObject({ answer: 'no' });
    expect(combineAnswers(q('figures'), [yes, bad, bad], 'majority')).toMatchObject({ status: 'error', votes: ['yes', 'error', 'error'] });
    expect(combineAnswers(q('figures'), [yes, yes, no], 'any-fail')).toMatchObject({ answer: 'no' });
    expect(combineAnswers(q('figures'), [yes, bad], 'any-fail')).toMatchObject({ status: 'error' });
    expect(combineAnswers(q('figures'), [yes, no, no], 'all-fail')).toMatchObject({ answer: 'yes' });
    expect(combineAnswers(q('figures'), [bad, bad], 'all-fail')).toMatchObject({ status: 'error' });
    expect(combineAnswers(q('figures'), [yes, no], 'mean')).toMatchObject({ score: 0.5, passed: true });
    expect(combineAnswers(q('figures'), [yes, bad], 'mean')).toMatchObject({ status: 'error' });
    const na = judgeAnswer(q('quotes'), 'na');
    expect(combineAnswers(q('quotes'), [na, na], 'mean')).toMatchObject({ status: 'na' });
    const numbers = [1, 5, 2].map(value => judgeAnswer(q('unused'), value));
    expect(combineAnswers(q('unused'), numbers, 'majority')).toMatchObject({ answer: 2 });
    expect(combineAnswers(q('unused'), [numbers[0]!, judgeAnswer(q('unused'), 'x'), judgeAnswer(q('unused'), 'y')], 'majority')).toMatchObject({ status: 'error' });
  });
  it('scores a graded output with open and hidden means and the gate', () => {
    expect(scoreQuestionnaire(bank, records({ figures: 'yes', quotes: 'na', padding: 'clause', unused: 2 })))
      .toEqual({ gate: 'pass', gateFailures: [], errors: [], score: 0.6875, scoreHidden: 0.75, scoreOpen: 0.6667 });
    expect(scoreQuestionnaire(bank, records({ figures: 'no', quotes: 'yes', padding: 'none', unused: 0 })))
      .toMatchObject({ gate: 'fail', gateFailures: ['figures'], score: 0.6, scoreHidden: 0.5, scoreOpen: 0.6667 });
    expect(scoreQuestionnaire(bank, records({ figures: 'perhaps', quotes: 'no', padding: 'none', unused: 0 })))
      .toMatchObject({ gate: 'error', gateFailures: [], errors: ['figures'] });
    expect(scoreQuestionnaire(bank, records({ figures: 'yes', quotes: 'no', padding: 'huge', unused: 0 })))
      .toMatchObject({ gate: 'pass', errors: ['padding'], scoreOpen: 0.3333 });
    expect(() => scoreQuestionnaire(bank, records({ figures: 'yes' }))).toThrow(/No record for: quotes, padding, unused/u);
  });
  it('reports no score when nothing applies', () => {
    const only = { ...bank, groups: [{ ...bank.groups[0]!, questions: bank.groups[0]!.questions.filter(question => question.id === 'quotes') }] };
    expect(scoreQuestionnaire(only, records({ quotes: 'na' }))).toMatchObject({ gate: 'pass', score: null, scoreHidden: null, scoreOpen: null });
  });
});
