import { describe, expect, it } from 'vitest';
import { count, one, pairs, parseArguments } from './arguments.js';

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
});
