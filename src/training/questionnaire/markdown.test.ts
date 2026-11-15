import { expect, it } from 'vitest';
import { renderQuestionnaireMarkdown } from './markdown.js';
import { summarizeQuestionnaire } from './report.js';
import { runQuestionnaire } from './run.js';
import { testBank, testJudge, testMaterial, testReplies } from './testSupport.js';

it('renders gates, open and hidden scores and per-question pass rates per candidate', async () => {
  const grade = (first: Record<string, unknown>) => runQuestionnaire({ bank: testBank(), material: testMaterial, judges: { strong: testJudge([first, testReplies[1]]) } });
  const baseline = summarizeQuestionnaire([await grade(testReplies[0]!)]);
  const candidate = summarizeQuestionnaire([await grade({ ...testReplies[0]!, figures: { answer: '?' }, quotes: { answer: 'yes', reason: 'x|y' } })]);
  const partial = { ...candidate, questions: candidate.questions.filter(question => question.id !== 'unused') };
  const text = renderQuestionnaireMarkdown({ baseline: { summary: baseline }, 'candidate-1': { summary: partial, score: 0.1, scoreOpen: null, scoreHidden: 0.2, gap: null, missing: 2 } });
  expect(text).toContain('| Candidate | Outputs | Missing | Gate pass | Gate fail | Gate error | All questions | Open | Hidden | Open minus hidden |');
  expect(text).toContain('| baseline | 1 | 0 | 1 | 0 | 0 | 0.688 | 0.667 | 0.750 | -0.083 |');
  expect(text).toContain('| candidate-1 | 3 | 2 | 0 | 0 | 1 | 0.100 | n/a | 0.200 | n/a |');
  expect(text).toContain('| figures |  | yes | 1.000 | n/a (1 errors) |');
  expect(text).toContain('| quotes | yes |  | n/a | 0.000 |');
  expect(text).toContain('| unused | yes |  | 1.000 | n/a |');
});
