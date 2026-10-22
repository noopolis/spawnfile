import { describe, expect, it } from 'vitest';
import { requiresArgumentBinding } from './binding.js';

describe('mandatory artifact argument equality', () => {
  const bound = new Set(['article']);
  it.each([
    'call.args.article == bindings.article',
    'bindings.article == call.args.article',
    'call.success && (call.args.article == bindings.article)',
    '(call.args.article == bindings.article) && (true || call.success)',
  ])('accepts required equality: %s', expression => {
    expect(requiresArgumentBinding(expression, bound)).toBe(true);
  });
  it.each([
    undefined, 3, 'x'.repeat(16_385), '(',
    'bindings.article != null', 'call.success',
    'call.args.article == bindings.other', 'call.args == bindings.article',
    'call.result.article == bindings.article', 'call.args.article == bindings.article.value',
    'call.args.article == bindings.article || true',
    '!(call.args.article != bindings.article)',
    'false == (call.args.article == bindings.article)',
    'true ? true : call.args.article == bindings.article',
    '"call.args.article == bindings.article" == "anything"',
    '[1].call.args.article == bindings.article',
    'call.success && true',
  ])('rejects unproven binding: %s', expression => {
    expect(requiresArgumentBinding(expression, bound)).toBe(false);
  });
});
