import { describe, it, expect } from 'vitest';
import { parseGrader, stableDigest, type Labels } from '../index.js';
import { groupLabelInstances, buildLabelPrompt, decodeLabelVotes, teacherPolicyDigest, adjudicationRows, validateStoredVotes, voteProvenance } from './index.js';

function grader() { return parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'l.yaml', calibration: 'c.json',
  teachers: [{ id: 't', provider: 'grok', model: 'm' }], model: { backend: 'teacher', teacher: 't' },
  escalate: { to: 't', between: [0.2, 0.8] }, questions: [
    { id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] },
    { id: 's', type: 'score', scale: [1, 3], expected: '>= 2', reads: ['output.body'], ask: 'Rate it' },
    { id: 'missing', type: 'yes-no', expected: 'yes', reads: ['output.absent'] },
  ], score: { method: 'weighted' } }); }

describe('label planning', () => {
  it('groups only identical ready projections and never leaks undeclared data', () => {
    const g = grader();
    g.questions.push({ ...g.questions[0]!, id: 'other', reads: ['output.secret'] });
    const groups = groupLabelInstances(g, { body: ['Hello'], secret: 'private' }, {});
    expect(groups).toHaveLength(2);
    expect(groups[0]!.instances.map(i => i.instance.key)).toEqual(['q', 's']);
    const prompt = buildLabelPrompt(groups[0]!);
    expect(prompt.prompt).not.toContain('private');
    expect(prompt.system).toContain('paideia.grader-label-prompt.v1');
    expect(prompt.schema).toMatchObject({ additionalProperties: false, required: ['q', 's'] });
    expect(prompt.digest).toHaveLength(64);
    expect(decodeLabelVotes('{"q":"yes","s":"2"}', groups[0]!)).toEqual({ q: 'yes', s: 2 });
    expect(decodeLabelVotes('{"q":"abstain","s":"abstain"}', groups[0]!)).toEqual({ q: 'abstain', s: 'abstain' });
    for (const text of ['bad', 'null', '[]', '3', '{}', '{"q":"yes","extra":"2"}', '{"q":3,"s":"2"}', '{"q":"maybe","s":"2"}', '{"q":"no","q":"yes","s":"2"}', '{"q":"no","\\u0071":"yes","s":"2"}']) {
      expect(decodeLabelVotes(text, groups[0]!)).toBeNull();
    }
  });
  it('samples consensus deterministically and retains every dispute', () => {
    const labels: Labels = { schema: 'paideia.labels.v1', grader: 'g', labelers: { t: { kind: 'model', provider: 'grok', model: 'm' } },
      labels: [{ id: 'a', lineage: 'a', output: {}, context: {}, votes: { q: { t: 'yes' }, s: { t: 2 }, missing: {} }, asked: ['t'], provenance: {} }] };
    const rows = adjudicationRows(labels, 1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ instance: 'missing', disputed: true, answer: null });
    expect(adjudicationRows(labels, 1)).toEqual(rows);
    expect(adjudicationRows(labels, 0)).toHaveLength(1);
  });
  it('resolves shared call receipts and refuses missing, stale or unrelated call references', () => {
    const g = grader(); const output = { body: ['Hello'] };
    const receipt = { teacher_policy_digest: teacherPolicyDigest(g.teachers[0]!),
      projection_digest: groupLabelInstances(g, output, {})[0]!.projectionDigest, instance_keys: ['q'] };
    const labels: Labels = { schema: 'paideia.labels.v1', grader: 'g',
      labelers: { t: { kind: 'model', provider: 'grok', model: 'm' } },
      labels: [{ id: 'l', lineage: 'l', output, context: {}, votes: { q: { t: 'yes' } },
        provenance: { t: { calls: { call: receipt }, votes: { q: { call: 'call', question_digest: stableDigest(g.questions[0]) } } } } }] };
    const label = labels.labels[0]!;
    expect(voteProvenance(label, 't', 'q')).toMatchObject(receipt);
    expect(() => validateStoredVotes(g, labels, { resolved: true })).not.toThrow();
    receipt.instance_keys = ['s'];
    expect(() => validateStoredVotes(g, labels)).toThrow('Stale vote');
    receipt.instance_keys = ['q']; receipt.teacher_policy_digest = 'stale';
    expect(() => validateStoredVotes(g, labels)).toThrow('Stale vote');
    delete label.provenance.t!.calls;
    expect(() => validateStoredVotes(g, labels)).toThrow('Stale vote');
    expect(voteProvenance(undefined, 't', 'q')).toBeUndefined();
    label.provenance.t!.votes = { q: 'invalid' };
    expect(voteProvenance(label, 't', 'q')).toBeUndefined();
  });
  it('refuses legacy and stale per-vote identities and exempts humans only from teacher policy', () => {
    const g = grader();
    const labels: Labels = { schema: 'paideia.labels.v1', grader: 'g', labelers: { t: { kind: 'model', provider: 'grok', model: 'm' }, h: { kind: 'human', name: 'H' } },
      labels: [{ id: 'a', lineage: 'a', output: {}, context: {}, votes: { q: { t: 'yes', h: 'yes' } }, provenance: {} }] };
    expect(() => validateStoredVotes(g, labels)).toThrow('Stale vote');
    const metadata = { question_digest: stableDigest(g.questions[0]), teacher_policy_digest: teacherPolicyDigest(g.teachers[0]!) };
    labels.labels[0]!.provenance.t = { votes: { q: metadata } };
    labels.labels[0]!.provenance.h = { votes: { q: metadata } };
    expect(() => validateStoredVotes(g, labels)).not.toThrow();
    labels.labels[0]!.output = { body: ['original'] };
    Object.assign(metadata, { projection_digest: groupLabelInstances(g, labels.labels[0]!.output, {})[0]!.projectionDigest });
    expect(() => validateStoredVotes(g, labels, { resolved: true })).not.toThrow();
    labels.labels[0]!.output = { body: ['changed'] };
    expect(() => validateStoredVotes(g, labels, { resolved: true })).toThrow('Stale');
    labels.labels[0]!.output = {};
    expect(() => validateStoredVotes(g, labels, { resolved: true })).toThrow('Stale');
    metadata.teacher_policy_digest = 'wrong';
    expect(() => validateStoredVotes(g, labels)).toThrow('Stale');
    metadata.teacher_policy_digest = teacherPolicyDigest(g.teachers[0]!);
    labels.labels[0]!.votes.unknown = { t: 'yes' };
    expect(() => validateStoredVotes(g, labels)).toThrow('Stale');
    delete labels.labels[0]!.votes.unknown;
    g.teachers = [];
    expect(() => validateStoredVotes(g, labels)).toThrow('Stale');
    delete labels.labels[0]!.votes.q!.t;
    expect(() => validateStoredVotes(g, labels)).not.toThrow();
  });
  it.each(['human', 'editor'] as const)('requires %s re-adjudication when the question or evidence changes', kind => {
    const g = grader(); g.questions[0]!.ask = 'Is it correct?';
    const output = { body: ['original'] };
    const vote = { question_digest: stableDigest(g.questions[0]),
      projection_digest: groupLabelInstances(g, output, {})[0]!.projectionDigest };
    const labels: Labels = { schema: 'paideia.labels.v1', grader: 'g', labelers: { human: { kind, name: 'Reader' } },
      labels: [{ id: 'human-truth', lineage: 'story', output, context: {}, votes: { q: { human: 'yes' } },
        provenance: { human: { votes: { q: vote } } } }] };
    expect(() => validateStoredVotes(g, labels, { resolved: true })).not.toThrow();
    g.teachers = [];
    expect(() => validateStoredVotes(g, labels, { resolved: true })).not.toThrow();
    g.questions[0]!.ask = 'Is it incorrect?';
    expect(() => validateStoredVotes(g, labels, { resolved: true })).toThrow('re-adjudicate');
    vote.question_digest = stableDigest(g.questions[0]);
    expect(() => validateStoredVotes(g, labels, { resolved: true })).not.toThrow();
    labels.labels[0]!.output = { body: ['changed'] };
    expect(() => validateStoredVotes(g, labels, { resolved: true })).toThrow('re-adjudicate');
    vote.projection_digest = groupLabelInstances(g, labels.labels[0]!.output, {})[0]!.projectionDigest;
    expect(() => validateStoredVotes(g, labels, { resolved: true })).not.toThrow();
    delete labels.labels[0]!.provenance.human;
    expect(() => validateStoredVotes(g, labels)).toThrow('re-adjudicate');
  });

});

it('pins the Codex containment policy separately from empty-tool teachers', () => {
  const teacher = { id: 'codex', provider: 'codex' as const, model: 'gpt-5' };
  expect(teacherPolicyDigest(teacher)).toBe(stableDigest({ teacher, prompt: 'paideia.grader-label-prompt.v1',
    policy: 'subscription-codex-containment-one-schema-repair.v1' }));
  expect(teacherPolicyDigest(teacher)).not.toBe(stableDigest({ teacher, prompt: 'paideia.grader-label-prompt.v1',
    policy: 'subscription-empty-tools-one-schema-repair.v1' }));
});
