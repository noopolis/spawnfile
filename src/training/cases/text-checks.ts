import { fail, number, safePath, sequence, string } from './validation.js';

export function textSelectors(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]) as string[];
}
export function isTextSelector(value: string): boolean {
  return value === 'output.text' || value === 'input:files' || /^context:[A-Za-z_][\w-]*$/.test(value) ||
    /^artifact:[^#]+(?:#(?:\/(?:[^~]|~[01])*)?)?$/.test(value);
}
export function validateTextCheck(parameters: Readonly<Record<string, unknown>>, path: string): void {
  const selectors = Array.isArray(parameters.input) ? sequence(parameters.input, `${path}.input`) : [parameters.input];
  selectors.forEach(value => {
    if (!isTextSelector(string(value, `${path}.input`))) fail(`${path}.input`, 'unsupported text selector');
  });
  if (parameters.ignore !== undefined) sequence(parameters.ignore, `${path}.ignore`, false).forEach(value => {
    try { new RegExp(string(value, `${path}.ignore`), 'gu'); }
    catch { fail(`${path}.ignore`, 'invalid Unicode regular expression'); }
  });
  const integer = (key: string) => {
    if (parameters[key] !== undefined && !Number.isSafeInteger(number(parameters[key], `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER))) {
      fail(`${path}.${key}`, 'expected a nonnegative safe integer');
    }
  };
  if (parameters.source !== undefined) {
    const sources = Array.isArray(parameters.source) ? sequence(parameters.source, `${path}.source`) : [parameters.source];
    sources.forEach(value => {
      const source = string(value, `${path}.source`);
      if (!isTextSelector(source)) {
        if (source.includes(':')) fail(`${path}.source`, 'unsupported source selector');
        safePath(source, `${path}.source`);
      }
    });
    integer('max_missing');
  } else {
    if (parameters.min === undefined && parameters.max === undefined) fail(path, 'word-count requires min or max');
    integer('min'); integer('max');
    if (typeof parameters.min === 'number' && typeof parameters.max === 'number' && parameters.min > parameters.max) fail(path, 'inverted word bounds');
  }
}
