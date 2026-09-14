import { describe, expect, it } from 'vitest';
import { parseDatasetYaml, resolveDataset } from './index.js';
import { canonical, json, number, safePath, sequence, uniqueStrings } from './validation.js';

const minimal = `schema: paideia.dataset.v1
id: arithmetic
records:
  - id: addition
    input:
      prompt: |\n        Reply with 4.\n
    checks:
      - id: correct
        eval: equals
        input: output.text
        value: "4"
`;
describe('strict YAML authoring', () => {
  it('preserves exact authored task bytes and source identity', () => {
    const parsed = parseDatasetYaml(minimal, { sourceName: 'train.paideia.yaml' });
    expect(parsed.dataset.records[0]!.input!.prompt).toBe('Reply with 4.\n');
    expect(parsed.locations['$.records[0].input.prompt']!.line).toBe(6);
    expect(parsed.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const resolved = resolveDataset(parsed);
    expect(resolved.records[0]!.effectiveStages[0]!.gate).toEqual({ all: [{ passed: 'correct' }] });
  });
  it.each([
    [minimal.replace('id: arithmetic', 'id: arithmetic\nid: duplicate'), /unique/],
    [minimal.replace('id: arithmetic', 'id: !secret arithmetic'), /tag/],
    [minimal.replace('id: arithmetic', 'id: &id arithmetic\nsubject: *id'), /aliases/],
    [minimal.replace('id: arithmetic', 'true: arithmetic'), /keys must be strings/],
    [minimal.replace('id: arithmetic', '__proto__: evil'), /unsupported key/],
    [minimal.replace('id: arithmetic', 'id: arithmetic\nlegacy: true'), /unknown field/],
    [minimal.replace('paideia.dataset.v1', 'paideia.dataset.v2'), /expected one/],
    [minimal.replace('records:', 'records: []\nunused:'), /unknown field/],
    [minimal.replace('eval: equals', 'eval: equals\n        not: {eval: equals}'), /exactly one/],
    ['---\nid: a\n---\nid: b', /multiple documents/],
  ])('rejects malformed or unsupported YAML', (text, message) => expect(() => parseDatasetYaml(text)).toThrow(message));
  it('limits source size, nodes and nesting before resolution', () => {
    expect(() => parseDatasetYaml(' '.repeat(2_000_001))).toThrow(/2 MB/);
    expect(() => parseDatasetYaml(`a: ${'['.repeat(70)}0${']'.repeat(70)}`)).toThrow(/depth/);
    expect(() => parseDatasetYaml(`a: [${Array.from({ length: 50_001 }, () => '0').join(',')}]`)).toThrow(/resource limit/);
  });
  it.each([
    ['records: []', /nonempty/],
    ['records: [{id: x, input: {prompt: x}, stages: [], checks: []}]', /at most/],
    ['records: [{id: x}, {id: x}]', /duplicate record/],
    ['fixtures: {x: {group: no}}\nrecords: [{id: x}]', /unknown field/],
    ['fixtures: {x: {input: {prompt: hi, message: {}}}}\nrecords: [{id: x}]', /at most/],
    ['records: [{id: x, use: [a, a]}]', /duplicate identity/],
    ['records: [{id: x, outputs: {x: /secret}}]', /relative path/],
    ['records: [{id: x, reference: {gold: answer}}]', /unknown field/],
    ['records: [{id: x, input: {files: [{resource: r, path: x, sha256: invalid}]}}]', /sha256/],
    ['live: {checks: [{id: a, on: event, eval: equals}, {id: a, on: event, eval: equals}]}\nrecords: [{id: x}]', /duplicate live/],
    ['live: {checks: [{id: a, on: timer, eval: equals}]}\nrecords: [{id: x}]', /mapping/],
    ['live: {checks: [{id: a, on: event, on_fail: kill, eval: equals}]}\nrecords: [{id: x}]', /expected one/],
    ['records: [{id: x, turns: [{id: a, input: {prompt: a}}, {id: a, input: {prompt: b}}]}]', /duplicate turn/],
    ['records: [{id: x, turns: [{id: a, after: {turn: b, outcome: completed}, input: {prompt: a}}]}]', /earlier turn/],
    ['checks: [{id: a, all: []}]\nrecords: [{id: x}]', /nonempty/],
    ['checks: [{id: a, not: {passed: x, extra: 1}}]\nrecords: [{id: x}]', /unknown field/],
    ['stages: [{id: a, checks: [{id: x, passed: y}], score: {linear: {x: 0}}}]\nrecords: [{id: x}]', /positive total/],
  ])('rejects invalid declared structures', (body, message) => {
    expect(() => parseDatasetYaml(`schema: paideia.dataset.v1\nid: invalid\n${body}`)).toThrow(message);
  });
  it('accepts explicit data, references, outputs and ordered external messages', () => {
    const yaml = `schema: paideia.dataset.v1
id: messages
subject: agent
records:
- id: thread
  group: one
  context: {x: true}
  reference: {labels: {expected: yes}}
  outputs: {answer: out/result.json}
  turns:
  - id: first
    input: {prompt: Start, data: {count: 2}}
    checks: [{id: ready, eval: equals, input: output.text, value: ready}]
  - id: second
    after: {turn: first, outcome: completed}
    input: {message: {network: local, sender: sensor, target: room:research, json: {answer: 4}}}
  checks: [{id: correct, eval: equals, input: output.text, value: 4}]
`;
    const resolved = resolveDataset(parseDatasetYaml(yaml), { subject: 'agent' });
    expect(resolved.records[0]!.turns).toHaveLength(2);
    expect(() => resolveDataset(parseDatasetYaml(yaml), { subject: 'other' })).toThrow(/subject/);
    const text = yaml.replace('json: {answer: 4}', 'text: Answer');
    expect(parseDatasetYaml(text).dataset.records[0]!.turns![1]!.input.message!.text).toBe('Answer');
  });
});
describe('shared scalar guards', () => {
  it('rejects non-data and filesystem escapes without implicit conversions', () => {
    for (const value of [undefined, Infinity, () => 1]) expect(() => json(value, '$')).toThrow();
    for (const path of ['/tmp/x', '../x', 'a/../x', 'C:/x', 'a\\b', 'x//y', './x', 'a\0b']) expect(() => safePath(path, '$')).toThrow();
    expect(() => number(NaN, '$')).toThrow();
    expect(sequence([], '$', false)).toEqual([]);
    expect(uniqueStrings([], '$', false)).toEqual([]);
    expect(json({ x: [true, null, 1] }, '$')).toEqual({ x: [true, null, 1] });
    expect(() => json({}, '$', 65)).toThrow(/nesting/);
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});

it('resolves only earlier trusted observation bindings within a multi-wake record', () => {
  const yaml = `schema: paideia.dataset.v1
id: multi
checks: [{id: complete, eval: equals, input: output.text, value: done}]
records:
- id: task
  turns:
  - id: request
    input: {prompt: Request research.}
    bind:
      request: {event: tool.complete, distinct: call.id, cardinality: one, value: call.result}
  - id: answer
    after: {turn: request, outcome: completed}
    input: {message: {network: local, sender: sensor, target: agent, json: {request_id: {binding: request.id}, answer: fact}}}
`;
  const resolved = resolveDataset(parseDatasetYaml(yaml));
  expect(resolved.records[0]!.turns![0]!.bind!.request!.value).toBe('call.result');
  expect(() => resolveDataset(parseDatasetYaml(yaml.replace('binding: request.id', 'binding: missing.id')))).toThrow(/earlier turn/);
  expect(() => resolveDataset(parseDatasetYaml(yaml.replace('    after: {turn: request, outcome: completed}', '    bind: {request: {event: output, distinct: event.id, cardinality: one, value: event.text}}')))).toThrow(/duplicate trusted binding/);
  expect(() => resolveDataset(parseDatasetYaml(minimal.replace('Reply with 4.', 'Reply with 4.').replace('      prompt:', '      data: {secret: {binding: missing}}\n      prompt:')))).toThrow(/earlier turn/);
});

it('uses explicit code-unit key order independent of locale collation', () => {
  expect(canonical({ a: 1, B: 2, ä: 3 })).toBe('{"B":2,"a":1,"ä":3}');
});
