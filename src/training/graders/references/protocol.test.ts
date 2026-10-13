import { describe, expect, it } from 'vitest';
import { councilPrompt, decodeCouncilAnswers } from './protocol.js';
import type { CheckInstance } from '../decomposition/index.js';

const instance: CheckInstance = { id: 'support@c1', template_id: 'support', unit_id: 'c1', type: 'choice',
  instructions: 'Supported?', criteria: { yes: 'Supported', no: 'Unsupported' }, expected: ['yes'], options: ['yes', 'no'],
  projection: { evidence: ['Verbatim quote', 42, null] }, digest: 'abc', status: 'ready', reasons: [] };
describe('strict council protocol', () => {
  it('projects only declared evidence and option descriptions', () => {
    const prompt = councilPrompt([instance]);
    expect(JSON.parse(prompt.prompt)).toEqual({ questions: [{ key: 'q1',
      type: 'choice', instructions: instance.instructions, evidence: instance.projection, criteria: [{ answer: 'yes', description: 'Supported' }, { answer: 'no', description: 'Unsupported' }] }] });
    expect(prompt.system).toContain('independently');
    expect(prompt.digest).toHaveLength(64);
    expect(councilPrompt([instance], { [instance.id]: [{ answer: 'yes' }] }).system).toContain('Adversarially');
  });
  it('maps positional keys to arbitrary check IDs in both phases and binds evidence by position', () => {
    const second = { ...instance, id: 'claim-supported@x1', projection: { text: 'Second quote' } };
    const instances = [instance, second];
    const wire = { q2: { answer: 'no', span: 'Second' }, q1: { answer: 'yes', span: 'Verbatim' } };
    for (const adjudication of [false, true]) {
      const prompt = councilPrompt(instances, adjudication ? { [second.id]: [{ answer: 'no' }] } : undefined);
      expect(prompt.schema).toMatchObject({ required: ['q1', 'q2'], additionalProperties: false });
      expect(Object.keys(prompt.schema.properties as object)).toEqual(['q1', 'q2']);
      expect(JSON.stringify(prompt.schema)).not.toContain('@');
      expect(JSON.parse(prompt.prompt).questions.map((q: { key: string }) => q.key)).toEqual(['q1', 'q2']);
      expect(decodeCouncilAnswers(JSON.stringify(wire), instances, adjudication))
        .toEqual({ [instance.id]: wire.q1, [second.id]: wire.q2 });
      expect(decodeCouncilAnswers(JSON.stringify(wire), [...instances].reverse(), adjudication)).toBeNull();
    }
    for (const bad of [{ ...wire, q3: wire.q1 }, { q1: wire.q1, other: wire.q2 },
      { [instance.id]: wire.q1, [second.id]: wire.q2 }]) {
      expect(decodeCouncilAnswers(JSON.stringify(bad), instances)).toBeNull();
    }
  });
  it('accepts only one surrounding JSON fence with the same strict validation', () => {
    const json = '{"q1":{"answer":"yes"}}';
    for (const newline of ['\n', '\r\n']) {
      const fence = ['```json', json, '```'].join(newline);
      expect(decodeCouncilAnswers(` ${fence} `, [instance])).toEqual({ [instance.id]: { answer: 'yes' } });
    }
    for (const bad of ['Prose\n```json\n' + json + '\n```', '```json\n' + json + '\n```\ntrailing',
      '```json\n```json\n' + json + '\n```\n```', '```json\n{"q1":{"answer":"yes"},"q1":{"answer":"no"}}\n```']) {
      expect(decodeCouncilAnswers(bad, [instance])).toBeNull();
    }
  });
  it('reverses the visible criterion descriptions for numeric score permutations', () => {
    const score = { ...instance, type: 'score' as const, criteria: { '1': 'low', '2': 'medium', '3': 'high' },
      options: ['1', '2', '3'] };
    const base = JSON.parse(councilPrompt([score]).prompt).questions[0];
    const permuted = JSON.parse(councilPrompt([{ ...score, options: [...score.options].reverse() }]).prompt).questions[0];
    expect(permuted.criteria).toEqual([...base.criteria].reverse());
    expect(permuted.criteria.map((criterion: { answer: string }) => criterion.answer)).toEqual(['3', '2', '1']);
    expect(permuted).not.toHaveProperty('options');
    expect(Object.keys(permuted)).toEqual(['key', 'type', 'instructions', 'evidence', 'criteria']);
  });
  it('accepts probability, verbatim span, abstention and adjudication uncertainty', () => {
    const value = { q1: { answer: 'yes', p: 0.8, span: 'Verbatim' } };
    expect(decodeCouncilAnswers(JSON.stringify(value), [instance])).toEqual({ [instance.id]: value.q1 });
    expect(decodeCouncilAnswers(JSON.stringify({ q1: { answer: 'abstain' } }), [instance]))
      .toEqual({ [instance.id]: { answer: null, status: 'abstain' } });
    expect(decodeCouncilAnswers(JSON.stringify({ q1: { answer: 'uncertain' } }), [instance], true))
      .toEqual({ [instance.id]: { answer: null, status: 'uncertain' } });
  });
  it.each(['broken', 'null', '[]', '{}', '{"q1":null}', '{"q1":[]}',
    '{"q1":{"answer":"yes"},"q1":{"answer":"no"}}',
    '{"other":{"answer":"yes"}}', '{"q1":{"answer":"unknown"}}',
    '{"q1":{"answer":true}}', '{"q1":{"answer":"yes","extra":1}}',
    '{"q1":{"answer":"yes","p":1.1}}', '{"q1":{"answer":"yes","p":-1}}',
    '{"q1":{"answer":"yes","p":"1"}}', '{"q1":{"answer":"yes","p":1e400}}',
    '{"q1":{"answer":"yes","span":"invented"}}', '{"q1":{"answer":"yes","span":1}}',
    '{"q1":{"answer":"yes","span":""}}'])('rejects malformed or ungrounded answers %s', text => {
    expect(decodeCouncilAnswers(text, [instance])).toBeNull();
  });
});
