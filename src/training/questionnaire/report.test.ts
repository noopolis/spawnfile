import { describe, expect, it } from 'vitest';
import { questionnaireFeedback, summarizeQuestionnaire } from './report.js';
import { runQuestionnaire } from './run.js';
import { parseBank } from './bank.js';
import { testBank, testBankYaml, testJudge, testMaterial, testReplies } from './testSupport.js';

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
  it('withholds working step and hidden question names an open question or its reason mentions', async () => {
    const bank = parseBank(testBankYaml.replace('ask: "Is every number in a row?"', 'ask: "Is every number in a row? Use support and numbers_list."'));
    const result = await runQuestionnaire({ bank, material: testMaterial, judges: { strong: testJudge([{ ...testReplies[0]!,
      figures: { answer: 'no', reason: 'support row 2 and quotes disagree; quotes-like and supported stay' } }, testReplies[1]!]) } });
    expect(questionnaireFeedback(result).failed).toEqual([{ id: 'figures', question: 'Is every number in a row? Use a withheld step and a withheld step.',
      answer: 'no', reason: 'a withheld step row 2 and a withheld step disagree; quotes-like and supported stay' }]);
    expect(result.answers.find(answer => answer.id === 'figures')!.ask).toContain('Use support');
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

describe('questionnaire ladder feedback', () => {
  const laddered = () => parseBank(testBankYaml.replace('        gate: true\n        rule: evidence fidelity', '        gate: true\n        penalty: 0.5\n        rule: evidence fidelity')
    .replace('        bands: [{ max: 1, score: 1 }, { max: 3, score: 0.75 }]\n        hidden: true', '        pass_when: { max: 1 }\n        gate: true\n        hidden: true'));
  const ladderGrade = (first: Record<string, unknown>, second: Record<string, unknown>) =>
    runQuestionnaire({ bank: laddered(), material: testMaterial, judges: { strong: testJudge([first, second]) } });
  it('names the lowest open rung and what the next one needs, never a hidden gate', async () => {
    const result = await ladderGrade({ ...testReplies[0]!, figures: { answer: 'no', reason: 'P1' } }, { padding: { answer: 'none', reason: '' }, unused: { answer: 5, reason: 'HIDDEN' } });
    expect(result.rungs).toEqual([{ id: 'figures', factor: 0.5 }, { id: 'unused', factor: 0.0625, count: 4 }]);
    const feedback = questionnaireFeedback(result);
    expect(feedback.ladder).toEqual({ search: 0.3334, failed: [{ id: 'figures' }], next: 'Clear gate figures: Is every number in a row?' });
    expect(JSON.stringify(feedback)).not.toContain('unused');
    const hiddenOnly = questionnaireFeedback(await ladderGrade(testReplies[0]!, { padding: { answer: 'none', reason: '' }, unused: { answer: 3, reason: 'HIDDEN' } }));
    expect(hiddenOnly).toMatchObject({ status: 'pass', ladder: { failed: [], next: expect.stringContaining('Every open gate passes') as string } });
    expect(JSON.stringify(hiddenOnly)).not.toContain('unused');
  });
  it('summarizes the search score and the strict acceptance rate', async () => {
    const results = [await ladderGrade(testReplies[0]!, { padding: { answer: 'none', reason: '' }, unused: { answer: 0, reason: '' } }),
      await ladderGrade({ ...testReplies[0]!, figures: { answer: 'no', reason: 'P1' } }, { padding: { answer: 'none', reason: '' }, unused: { answer: 0, reason: '' } })];
    expect(summarizeQuestionnaire(results)).toMatchObject({ acceptance: 0.5, search: 0.6875 });
    expect(questionnaireFeedback(results[0]!).ladder).toBeDefined();
    expect(questionnaireFeedback(await grade(testReplies[0]!)).ladder).toBeUndefined();
  });
});
