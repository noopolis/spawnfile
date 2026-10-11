import { describe, expect, it } from 'vitest';
import { councilPrompt, decodeCouncilAnswers } from './protocol.js';
import type { CheckInstance } from '../decomposition/index.js';

const instance: CheckInstance = { id: 'support@c1', template_id: 'support', unit_id: 'c1', type: 'choice',
  instructions: 'Supported?', criteria: { yes: 'Supported', no: 'Unsupported' }, expected: ['yes'], options: ['yes', 'no'],
  projection: { evidence: ['Verbatim quote', 42, null] }, digest: 'abc', status: 'ready', reasons: [] };
describe('strict council protocol', () => {
  it('projects only declared evidence and option descriptions', () => {
    const prompt = councilPrompt([instance]);
    expect(JSON.parse(prompt.prompt)).toEqual({ projection: instance.projection, questions: [{ check_id: instance.id,
      type: 'choice', instructions: instance.instructions, criteria: [{ answer: 'yes', description: 'Supported' }, { answer: 'no', description: 'Unsupported' }] }] });
    expect(prompt.system).toContain('independently');
    expect(prompt.digest).toHaveLength(64);
    expect(councilPrompt([instance], { [instance.id]: [{ answer: 'yes' }] }).system).toContain('Adversarially');
  });
  it('reverses the visible criterion descriptions for numeric score permutations', () => {
    const score = { ...instance, type: 'score' as const, criteria: { '1': 'low', '2': 'medium', '3': 'high' },
      options: ['1', '2', '3'] };
    const base = JSON.parse(councilPrompt([score]).prompt).questions[0];
    const permuted = JSON.parse(councilPrompt([{ ...score, options: [...score.options].reverse() }]).prompt).questions[0];
    expect(permuted.criteria).toEqual([...base.criteria].reverse());
    expect(permuted.criteria.map((criterion: { answer: string }) => criterion.answer)).toEqual(['3', '2', '1']);
    expect(permuted).not.toHaveProperty('options');
    expect(Object.keys(permuted)).toEqual(['check_id', 'type', 'instructions', 'criteria']);
  });
  it('accepts probability, verbatim span, abstention and adjudication uncertainty', () => {
    const value = { [instance.id]: { answer: 'yes', p: 0.8, span: 'Verbatim' } };
    expect(decodeCouncilAnswers(JSON.stringify(value), [instance])).toEqual(value);
    expect(decodeCouncilAnswers(JSON.stringify({ [instance.id]: { answer: 'abstain' } }), [instance])).not.toBeNull();
    expect(decodeCouncilAnswers(JSON.stringify({ [instance.id]: { answer: 'uncertain' } }), [instance], true)).not.toBeNull();
  });
  it.each(['broken', 'null', '[]', '{}', '{"support@c1":null}', '{"support@c1":[]}',
    '{"support@c1":{"answer":"yes"},"support@c1":{"answer":"no"}}',
    '{"other":{"answer":"yes"}}', '{"support@c1":{"answer":"unknown"}}',
    '{"support@c1":{"answer":true}}', '{"support@c1":{"answer":"yes","extra":1}}',
    '{"support@c1":{"answer":"yes","p":1.1}}', '{"support@c1":{"answer":"yes","p":-1}}',
    '{"support@c1":{"answer":"yes","p":"1"}}', '{"support@c1":{"answer":"yes","p":1e400}}',
    '{"support@c1":{"answer":"yes","span":"invented"}}', '{"support@c1":{"answer":"yes","span":1}}',
    '{"support@c1":{"answer":"yes","span":""}}'])('rejects malformed or ungrounded answers %s', text => {
    expect(decodeCouncilAnswers(text, [instance])).toBeNull();
  });
});
