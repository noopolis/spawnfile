import { describe, expect, it } from 'vitest';
import { groupSchema, questionnaireSystem, renderGroupPrompt, renderRead } from './prompt.js';
import { testBank, testMaterial } from './testSupport.js';

const bank = testBank();

describe('questionnaire prompt', () => {
  it('renders the declared material and the steps without scoring data', () => {
    const prompt = renderGroupPrompt(bank, bank.groups[0]!, testMaterial);
    expect(prompt).toContain('You are a strict checker.\n\nHEADLINE: Six stations closed\n\n=== BODY ===\nP1: First fact [E1].\nP2: Second fact [E2].');
    expect(prompt).toContain('=== FILED ROWS ===\nE1: a.example | verified\n  text: six stations\n  raw: six stations closed\nE2: b.example | none\n  text: reopened\n\n');
    expect(prompt).toContain('=== OTHER ROWS ===\nX1: c.example: unfiled');
    expect(prompt).toContain('=== ASSIGNMENT ===\nReport the closure.\nBrief.');
    expect(prompt).toContain('1. numbers_list [WORK, list]: List every number.');
    expect(prompt).toContain('3. figures [yes-no]: Is every number in a row?\n   yes when: every number is in a row\n   no when: a number has no row');
    expect(prompt).toContain('   na only when: there are no quotes');
    expect(prompt).not.toMatch(/weight|hidden|gate|score|rule|evidence fidelity/u);
    expect(prompt).not.toContain('EARLIER WORKING');
    expect(questionnaireSystem).toContain('untrusted data');
  });
  it('hands earlier working to a later group and lists options by id only', () => {
    const prompt = renderGroupPrompt(bank, bank.groups[1]!, testMaterial, { 'fidelity.support': 'P1: E1', 'fidelity.numbers_list': ['six', 'two'] });
    expect(prompt).toContain('fidelity.support:\nP1: E1\n\nfidelity.numbers_list:\n- six\n- two');
    expect(prompt).toContain('   - clause: when a clause');
    expect(prompt).not.toContain('0.5');
  });
  it('renders absent, scalar, object and unlisted values', () => {
    const material = { output: { count: 3, meta: { a: 1 }, list: 'not a list', __proto__: null }, context: {} };
    expect(renderRead({ from: 'output.missing', title: 'MISSING' }, material)).toBe('MISSING: (none)');
    expect(renderRead({ from: 'output.count', title: 'COUNT' }, material)).toBe('COUNT: 3');
    expect(renderRead({ from: 'output.meta', title: 'META' }, material)).toBe('=== META ===\n{"a":1}');
    expect(renderRead({ from: 'output.list', title: 'LIST', list: 'L' }, material)).toBe('=== LIST ===\n(none)');
    expect(renderRead({ from: 'output.constructor', title: 'C' }, material)).toBe('C: (none)');
    expect(renderRead({ from: 'output', title: 'ALL', list: 'I' }, { output: ['a', { b: 1 }], context: {} })).toBe('=== ALL ===\nI1: a\nI2: {"b":1}');
    expect(renderRead({ from: 'output.rows', title: 'R', list: 'E', distinct_from: 'context.other', by: ['id'] },
      { output: { rows: [{ id: 1 }] }, context: {} })).toBe('=== R ===\nE1: {"id":1}');
    expect(renderRead({ from: 'output.rows', title: 'R', list: 'E', template: 'fixed line' }, { output: { rows: [1] }, context: {} })).toBe('=== R ===\nE1: fixed line');
  });
  it('constrains the reply to one typed property per step', () => {
    const schema = groupSchema(bank.groups[0]!) as { required: string[]; properties: Record<string, { required: string[]; properties: { answer: unknown } }> };
    expect(schema.required).toEqual(['numbers_list', 'support', 'figures', 'quotes']);
    expect(schema.properties.numbers_list).toMatchObject({ required: ['answer'], properties: { answer: { type: 'array' } } });
    expect(schema.properties.support!.properties.answer).toEqual({ type: 'string' });
    expect(schema.properties.figures).toMatchObject({ required: ['answer', 'reason'], properties: { answer: { enum: ['yes', 'no'] } } });
    expect(schema.properties.quotes!.properties.answer).toEqual({ type: 'string', enum: ['yes', 'no', 'na'] });
    const house = groupSchema(bank.groups[1]!) as typeof schema;
    expect(house.properties.padding!.properties.answer).toEqual({ type: 'string', enum: ['none', 'clause', 'paragraph'] });
    expect(house.properties.unused!.properties.answer).toEqual({ type: 'number' });
    const group = { ...bank.groups[1]!, questions: [{ ...bank.groups[1]!.questions[1]!, na_when: 'no rows' }] };
    expect((groupSchema(group) as typeof schema).properties.unused!.properties.answer).toEqual({ type: 'string' });
  });
});
