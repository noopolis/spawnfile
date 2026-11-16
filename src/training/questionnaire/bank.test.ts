import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { BankError, bankContexts, bankJudges, bankQuestions, parseBank, validateBank } from './bank.js';
import { testBank, testBankYaml } from './testSupport.js';

type Raw = { groups: { questions: Record<string, unknown>[] }[] } & Record<string, unknown>;
const edit = (change: (bank: Raw) => void) => { const bank = parse(testBankYaml) as Raw; change(bank); return () => validateBank(bank); };
const question = (bank: Raw, group: number, index: number) => bank.groups[group]!.questions[index]!;

describe('questionnaire bank', () => {
  it('fills defaults and keeps declared order', () => {
    const bank = testBank();
    expect(bank.groups.map(group => [group.id, group.judge, group.effort, group.repeats, group.combine]))
      .toEqual([['fidelity', 'strong', 'medium', 1, 'any-fail'], ['house', 'strong', 'medium', 1, 'majority']]);
    expect(bankQuestions(bank, 'scored').map(entry => entry.id)).toEqual(['figures', 'quotes', 'padding', 'unused']);
    expect(bankQuestions(bank, 'scaffold').map(entry => entry.id)).toEqual(['numbers_list', 'support']);
    expect(bankQuestions(bank).find(entry => entry.id === 'padding')).toMatchObject({ weight: 2, gate: false, hidden: false, pass_min: 0.5, group: 'house' });
    expect(bank.reads[0]).toEqual({ from: 'output.headline', title: 'HEADLINE' });
    expect(bankContexts(bank)).toEqual(['evidence', 'assignment']);
    expect(bankJudges(bank)).toEqual(['strong']);
  });
  it('accepts numeric option ids and a pass range', () => {
    const bank = edit(raw => {
      question(raw, 1, 0).options = [{ id: 1, when: 'a', score: 1 }, { id: 2, when: 'b', score: 0 }];
      Object.assign(question(raw, 1, 1), { bands: undefined, pass_when: { max: 2 } });
      delete question(raw, 1, 1).bands;
      delete raw.defaults; delete raw.version;
    })();
    expect(bankQuestions(bank).find(entry => entry.id === 'padding')!.options!.map(option => option.id)).toEqual(['1', '2']);
    expect(bank.groups[0]!.effort).toBeUndefined();
  });
  it.each([
    ['unknown schema', (raw: Raw) => { raw.schema = 'other'; }],
    ['unknown key', (raw: Raw) => { question(raw, 0, 2).bonus = 1; }],
    ['repeated question id', (raw: Raw) => { question(raw, 1, 0).id = 'figures'; }],
    ['repeated group id', (raw: Raw) => { (raw.groups[1] as unknown as { id: string }).id = 'fidelity'; }],
    ['after an undeclared group', (raw: Raw) => { (raw.groups[0] as unknown as { after: string[] }).after = ['house']; }],
    ['receives a scored question', (raw: Raw) => { (raw.groups[1] as unknown as { receives: string[] }).receives = ['fidelity.figures']; }],
    ['scored role on a scaffold type', (raw: Raw) => { question(raw, 0, 1).role = 'scored'; }],
    ['scoring keys on a scaffold step', (raw: Raw) => { question(raw, 0, 0).weight = 2; }],
    ['scored question without a rule', (raw: Raw) => { delete question(raw, 0, 2).rule; }],
    ['yes-no without criteria', (raw: Raw) => { delete question(raw, 0, 2).yes_when; }],
    ['options on a yes-no question', (raw: Raw) => { question(raw, 0, 2).options = [{ id: 'a', when: 'a', score: 1 }, { id: 'b', when: 'b', score: 0 }]; }],
    ['an option named na', (raw: Raw) => { question(raw, 1, 0).options = [{ id: 'na', when: 'a', score: 1 }, { id: 'b', when: 'b', score: 0 }]; }],
    ['a number question with both scorings', (raw: Raw) => { question(raw, 1, 1).pass_when = { max: 1 }; }],
    ['an empty pass range', (raw: Raw) => { delete question(raw, 1, 1).bands; question(raw, 1, 1).pass_when = {}; }],
    ['falling bands', (raw: Raw) => { question(raw, 1, 1).bands = [{ max: 3, score: 1 }, { max: 1, score: 0 }]; }],
    ['bands on a yes-no question', (raw: Raw) => { question(raw, 0, 2).bands = [{ max: 1, score: 1 }]; }],
    ['repeats above 8', (raw: Raw) => { (raw.groups[0] as unknown as { repeats: number }).repeats = 9; }],
    ['a template without list', (raw: Raw) => { raw.reads = [{ from: 'output.body', template: '{a}' }]; }],
    ['distinct_from without by', (raw: Raw) => { raw.reads = [{ from: 'output.body', list: 'P', distinct_from: 'output.rows' }]; }],
    ['a penalty on a question that is no gate', (raw: Raw) => { question(raw, 1, 0).penalty = 0.5; }],
    ['a penalty on a scaffold step', (raw: Raw) => { question(raw, 0, 0).penalty = 0.5; }],
    ['a penalty of 1', (raw: Raw) => { question(raw, 0, 2).penalty = 1; }],
    ['a bank penalty below 0', (raw: Raw) => { raw.penalty = -0.1; }],
    ['no scored question', (raw: Raw) => { raw.groups = [{ id: 'only', questions: [{ id: 'notes', type: 'free-text', ask: 'Notes.' }] }] as never; }],
  ])('refuses %s', (_name, change) => {
    expect(edit(change)).toThrow(BankError);
  });
  it('refuses duplicate YAML keys and reads strict YAML', () => {
    expect(() => parseBank(`${testBankYaml}\nid: again\n`)).toThrow(/YAML/u);
    expect(parseBank(stringify(parse(testBankYaml))).id).toBe('test-bank');
  });
});
