import type { InferenceProvider } from '../contracts/execution.js';
import { parseBank } from './bank.js';
import type { QuestionnaireJudge } from './run.js';

/** A two-group bank exercising every answer type, hand-off, a gate and a hidden question. */
export const testBankYaml = `
schema: spawnfile.training.questionnaire.v1
id: test-bank
version: 1
instructions: "You are a strict checker."
reads:
  - output.headline
  - { from: output.body, title: BODY, list: P }
  - { from: output.rows, title: FILED ROWS, list: E, template: "{source} | {note.kind}\\n  text: {text}\\n  raw: {note.raw}" }
  - { from: context.evidence, title: OTHER ROWS, list: X, template: "{source}: {text}", distinct_from: output.rows, by: [source, text] }
  - context.assignment
defaults: { judge: strong, effort: medium, repeats: 1, combine: majority }
groups:
  - id: fidelity
    combine: any-fail
    questions:
      - { id: numbers_list, type: extraction-list, ask: "List every number." }
      - { id: support, type: free-text, role: scaffold, ask: "Name the row for each sentence." }
      - id: figures
        type: yes-no
        ask: "Is every number in a row?"
        yes_when: every number is in a row
        no_when: a number has no row
        pass: yes
        gate: true
        rule: evidence fidelity
      - id: quotes
        type: yes-no
        ask: "Is any quote changed?"
        yes_when: a quote is changed
        no_when: every quote is exact
        pass: no
        na_when: there are no quotes
        hidden: true
        rule: quotes stay exact
  - id: house
    after: [fidelity]
    receives: [fidelity.support, fidelity.numbers_list]
    questions:
      - id: padding
        type: multiple-choice
        ask: "How much padding?"
        options:
          - { id: none, when: no padding, score: 1 }
          - { id: clause, when: a clause, score: 0.5 }
          - { id: paragraph, when: a paragraph, score: 0 }
        weight: 2
        rule: no padding
      - id: unused
        type: number
        ask: "How many rows are unused?"
        bands: [{ max: 1, score: 1 }, { max: 3, score: 0.75 }]
        hidden: true
        rule: use the rows
`;
export const testBank = () => parseBank(testBankYaml);

export const testMaterial = { output: { headline: 'Six stations closed', body: ['First fact [E1].', 'Second fact [E2].'],
  rows: [{ source: 'a.example', text: 'six stations', note: { kind: 'verified', raw: 'six stations closed' } }, { source: 'b.example', text: 'reopened' }] },
context: { evidence: [{ source: 'a.example', text: 'six stations' }, { source: 'c.example', text: 'unfiled' }], assignment: 'Report the closure.\nBrief.' } };

export const testReplies: Record<string, unknown>[] = [
  { numbers_list: { answer: ['six, headline'] }, support: { answer: 'P1: E1' }, figures: { answer: 'yes', reason: 'all found' }, quotes: { answer: 'na', reason: 'no quotes' } },
  { padding: { answer: 'clause', reason: 'P2 "second"' }, unused: { answer: 2, reason: 'X2' } },
];

/** A judge route answering from a queue; each entry is a reply object, raw text or an error to throw. */
export function testJudge(replies: readonly unknown[], effort: string | null = 'medium'): QuestionnaireJudge & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  const provider: InferenceProvider = { id: 'test-provider', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate(request) {
      prompts.push(request.prompt);
      const reply = replies[index++];
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), model: request.model, modelBasis: 'requested-assumption', usage: null, route: 'test' };
    } };
  return { provider, model: 'judge-model', ...(effort === null ? {} : { effort }), prompts };
}
