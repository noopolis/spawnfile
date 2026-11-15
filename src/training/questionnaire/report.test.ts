import { describe, expect, it } from 'vitest';
import { questionnaireFeedback, summarizeQuestionnaire } from './report.js';
import { runQuestionnaire } from './run.js';
import { testBank, testJudge, testMaterial, testReplies } from './testSupport.js';

const grade = (first: Record<string, unknown>, second: Record<string, unknown> = testReplies[1]!) =>
  runQuestionnaire({ bank: testBank(), material: testMaterial, judges: { strong: testJudge([first, second]) } });
const hiddenFailing = { ...testReplies[0]!, quotes: { answer: 'yes', reason: 'HIDDEN-REASON P1' } };

describe('questionnaire feedback', () => {
  it('shows failed open questions and nothing hidden', async () => {
    const result = await grade({ ...hiddenFailing, figures: { answer: 'no', reason: 'P1 "seven"' } }, { padding: { answer: 'paragraph', reason: 'P3' }, unused: { answer: 9, reason: 'HIDDEN-ROWS' } });
    const feedback = questionnaireFeedback(result);
    expect(feedback).toEqual({ status: 'fail', score: 0, failed: [
      { id: 'figures', question: 'Is every number in a row?', answer: 'no', reason: 'P1 "seven"' },
      { id: 'padding', question: 'How much padding?', answer: 'paragraph', reason: 'P3' }] });
    const text = JSON.stringify(feedback);
    for (const secret of ['quotes', 'unused', 'HIDDEN', 'numbers_list', 'support', 'P1: E1', 'weight']) expect(text).not.toContain(secret);
  });
  it('does not fail the open gate on a hidden question and reports open errors', async () => {
    expect(questionnaireFeedback(await grade(hiddenFailing))).toEqual({ status: 'pass', score: 0.6667, failed: [] });
    expect(questionnaireFeedback(await grade({ ...testReplies[0]!, figures: { answer: '?' } }))).toMatchObject({ status: 'error', failed: [] });
  });
});

describe('questionnaire summary', () => {
  it('reports pass rates, gates and the open minus hidden gap', async () => {
    const results = [await grade(testReplies[0]!), await grade({ ...hiddenFailing, figures: { answer: 'no', reason: 'x' } }), await grade({ ...testReplies[0]!, figures: { answer: '?' } })];
    const summary = summarizeQuestionnaire(results);
    expect(summary).toMatchObject({ outputs: 3, gatePassed: 1, gateFailed: 1, gateErrors: 1, score: 0.4917, scoreOpen: 0.4444, scoreHidden: 0.625, gap: -0.1806 });
    expect(summary.questions.find(question => question.id === 'figures')).toEqual({ id: 'figures', hidden: false, gate: true, asked: 3, passed: 1, failed: 1, na: 0, errors: 1, passRate: 0.5, meanScore: 0.5 });
    expect(summary.questions.find(question => question.id === 'quotes')).toMatchObject({ hidden: true, na: 2, failed: 1, passRate: 0 });
    expect(summarizeQuestionnaire([])).toMatchObject({ outputs: 0, score: null, gap: null, questions: [] });
  });
});
