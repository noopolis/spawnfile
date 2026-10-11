import { describe, expect, it } from 'vitest';
import { count, judgeCitationRepairs, one, pairs, parseArguments } from './arguments.js';

describe('explicit bounded CLI arguments', () => {
  it.each([[], ['help'], ['--help'], ['-h']])('shows help for %j', (...argv) => {
    expect(parseArguments(argv)).toEqual({ command: 'help', flags: {} });
  });
  it('preserves repeated selections and argument bytes', () => {
    expect(parseArguments(['evaluate', 'suite with spaces.yaml', '--instructions', 'AGENTS.md', '--instructions', 'SOUL.md']))
      .toEqual({ command: 'evaluate', dataset: 'suite with spaces.yaml', flags: { instructions: ['AGENTS.md', 'SOUL.md'] } });
    expect(parseArguments(['train', '--train', 'train.yaml', '--test', 'test.yaml']).dataset).toBeUndefined();
  });
  it.each([
    ['rescore'], ['validate'], ['validate', 'a', 'b'], ['train', 'extra'], ['validate', 'a', '--runtime', 'codex'],
    ['evaluate', 'a', '-x'], ['evaluate', 'a', '--model'], ['evaluate', 'a', '--model', ''],
    ['evaluate', 'a', '--model', '--other'], ['evaluate', 'a', '--model', 'a', '--model', 'b'],
  ])('rejects unsupported, missing or ambiguous arguments: %j', (...argv) => { expect(() => parseArguments(argv)).toThrow(); });
  it('requires explicit values and integer bounds without dropping controls', () => {
    const args = parseArguments(['train']);
    expect(() => one(args, 'model')).toThrow('Required option');
    expect(one(args, 'model', 'explicit')).toBe('explicit');
    expect(count(args, 'seed', 0, 100, 0)).toBe(0);
    for (const value of ['-1', '1.5', '1e2', '1001', '0', '9007199254740992']) {
      expect(() => count({ ...args, flags: { budget: [value] } }, 'budget', 1, 1000)).toThrow('integer');
    }
    expect(() => one({ ...args, flags: { model: ['  '] } }, 'model')).toThrow('missing');
  });
  it('accepts named mappings and rejects duplicates/prototype keys/missing values', () => {
    expect(pairs(['archive=../private', 'judge=model=variant'])).toEqual({ archive: '../private', judge: 'model=variant' });
    for (const values of [['missing'], ['=value'], ['name='], ['name=  '], ['__proto__=value'], ['n=a', 'n=b']]) {
      expect(() => pairs(values)).toThrow('unique NAME=VALUE');
    }
  });
  it('requires literal citation repair counts for unique declared judges', () => {
    const args = ['train', '--judge', 'prose=model-a', '--judge', 'grounding=model-b'];
    expect(judgeCitationRepairs(parseArguments(args))).toEqual({ prose: 0, grounding: 0 });
    expect(judgeCitationRepairs(parseArguments([...args, '--judge-citation-repairs', 'prose=1',
      '--judge-citation-repairs', 'grounding=0']))).toEqual({ prose: 1, grounding: 0 });
    for (const value of ['prose=2', 'prose=-1', 'prose=01', 'prose=1.0', 'prose=true', 'prose= 1',
      'prose=1 ', 'prose=1=0', 'prose=$(false)', 'missing=1', 'constructor=1']) {
      expect(() => parseArguments([...args, '--judge-citation-repairs', value])).toThrow();
    }
    expect(() => parseArguments([...args, '--judge-citation-repairs', 'prose=1', '--judge-citation-repairs', 'prose=0']))
      .toThrow('unique NAME=VALUE');
  });
});

it('parses grader commands and rejects unsupported/missing/repeated flags', () => {
  expect(parseArguments(['grader', 'validate', '--grader', 'g.yaml'])).toMatchObject({ command: 'grader', graderCommand: 'validate' });
  expect(parseArguments(['grader', 'calibrate', '--grader', 'g', '--exclude-dataset', 'a', '--exclude-dataset', 'b']).flags['exclude-dataset']).toEqual(['a', 'b']);
  expect(parseArguments(['grader', 'label', '--grader', 'g', '--inputs', 'i', '--teachers', 'a', '--relabel']).flags.relabel).toEqual(['true']);
  expect(parseArguments(['grader', 'grade', '--grader', 'g', '--output', 'o.json', '--context', 'a=a.json', '--context', 'b=b.md']).flags.context).toEqual(['a=a.json', 'b=b.md']);
  expect(parseArguments(['grader', 'expand', '--grader', 'g', '--output', 'o.json', '--context', 'a=a.json', '--context', 'b=b.md']))
    .toEqual({ command: 'grader', graderCommand: 'expand', flags: { grader: ['g'], output: ['o.json'], context: ['a=a.json', 'b=b.md'] } });
  for (const argv of [['grader'], ['grader', 'grade'], ['grader', 'validate'], ['grader', 'validate', '--grader', 'g', 'extra'],
    ['grader', 'grade', '--grader', 'g'], ['grader', 'grade', '--grader', 'g', '--output', 'o', '--output', 'other'],
    ['grader', 'expand', '--grader', 'g'], ['grader', 'expand', '--output', 'o'],
    ['grader', 'expand', '--grader', 'g', '--output', 'o', '--output', 'other'],
    ['grader', 'expand', '--grader', 'g', '--output', 'o', '--teachers', 'teacher'],
    ['grader', 'label', '--grader', 'g', '--inputs', 'i'], ['grader', 'validate', '--grader', 'a', '--grader', 'b']]) {
    expect(() => parseArguments(argv)).toThrow();
  }
});

it.each(['validate', 'label', 'calibrate', 'grade', 'expand'])('accepts the bounded whole-command deadline for grader %s', command => {
  const required = command === 'label' ? ['--inputs', 'inputs.yaml', '--teachers', 'teacher']
    : command === 'grade' || command === 'expand' ? ['--output', 'output.json'] : [];
  const args = parseArguments(['grader', command, '--grader', 'grader.yaml', ...required, '--timeout-ms', '3600000']);
  expect(count(args, 'timeout-ms', 180000, 3600000)).toBe(3600000);
  expect(() => count({ ...args, flags: { ...args.flags, 'timeout-ms': ['3600001'] } }, 'timeout-ms', 180000, 3600000)).toThrow('integer');
});
