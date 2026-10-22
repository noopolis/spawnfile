import { Environment } from '@marcbachmann/cel-js';
import { ownPath } from '../selectors.js';

const environment = new Environment({ limits: { maxAstNodes: 1_000, maxDepth: 40,
  maxListElements: 1_000, maxMapEntries: 1_000, maxCallArguments: 32 } })
  .registerVariable('call', 'dyn').registerVariable('context', 'dyn')
  .registerVariable('bindings', 'dyn').registerVariable('event', 'dyn');

export function predicate(expression: string, values: Record<string, unknown>): boolean | undefined {
  if (expression.length > 16_384) throw new Error('CEL expression exceeds limit');
  const parsed = environment.parse(expression);
  try {
    const value: unknown = parsed(values);
    if (typeof value !== 'boolean') throw new Error('CEL predicate must return boolean');
    return value;
  } catch (error) {
    // Missing observation data is uncertainty, not a successful match or invented field.
    if (error instanceof Error && /no such key|not found|undefined|undeclared|missing/i.test(error.message)) return undefined;
    throw error;
  }
}

export function bindingValue(selector: string, values: Record<string, unknown>): unknown {
  return ownPath(values, selector.split('.'));
}
