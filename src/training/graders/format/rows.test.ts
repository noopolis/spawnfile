import { expect, it } from 'vitest';
import { rowsSchema } from './rows.js';

const valid = { heading: '^### \\[(E\\d+)\\]', cite: '\\[(E\\d+)\\]' };

it.each([
  ['backreferences', '(a)\\1'],
  ['backreferences', '(?<id>a)\\k<id>'],
  ['lookaround', '(a)(?=b)'],
  ['lookaround', '(a)(?!b)'],
  ['lookaround', '(?<=a)(b)'],
  ['lookaround', '(?<!a)(b)'],
  ['star height', '^(a+)+$'],
  ['star height', '^(a*)?$'],
  ['star height', '^(a?)*$'],
  ['star height', '^(a{2,4}){2}$'],
  ['star height', '^(a+|b)+$'],
  ['star height', '^(?:(?:a+)|b(c))*$'],
  ['star height', '^(?:(a+))+$'],
])('rejects unsafe %s in either row regex: %s', (reason, pattern) => {
  for (const field of ['heading', 'cite']) {
    const parsed = rowsSchema.safeParse({ ...valid, [field]: pattern });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.path).toEqual([field]);
      expect(parsed.error.issues[0]!.message).toContain(reason);
    }
  }
});

it.each([
  '(E\\d+)', '(E\\d+?)', '(E\\d{1,8})', '(E\\d{1,})', '(E\\d{2})',
  '^(?:ROW)\\((?<id>[a-z]+)\\):', '(a|b)', '(ab)?', '(ab)*', '(ab)+',
  '([()|+*?{}\\]\\\\]+)', '(a)\\\\1', '(a)\\\\k<id>',
  '(a)\\(\\?=b\\)', '([\\1])', '(a){literal}', '()',
])('preserves accepted syntax and escaped metacharacters: %s', pattern => {
  expect(rowsSchema.parse({ heading: pattern, cite: pattern })).toMatchObject({ heading: pattern, cite: pattern });
});

it('rejects the reported exponential pattern before executing it on context', () => {
  expect(() => rowsSchema.parse({ ...valid, heading: '^(a+)+$' })).toThrow('star height');
});
