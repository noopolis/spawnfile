import type { DataValue, TaskInput, TurnBinding } from '../../contracts/dataset.js';
import type { BindingScope } from './types.js';
import { capturedCalls } from '../../capture/index.js';
import { ownPath, predicate, bindingValue } from '../../evaluation/index.js';

export function captureBindings(declarations: Readonly<Record<string, TurnBinding>>, scope: BindingScope): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const calls = capturedCalls(scope.events);
  for (const [name, binding] of Object.entries(declarations)) {
    const matches = new Map<string, unknown>();
    for (const event of scope.events) {
      if (event.type !== binding.event) continue;
      const call = calls.find(item => item.id === event.callId);
      const values = { event, call, context: scope.context, bindings: {} };
      if (binding.where && predicate(binding.where.cel, values) !== true) continue;
      const key = binding.distinct === 'event.id' ? event.id : event.callId;
      const value = bindingValue(binding.value, values);
      if (!key || value === undefined) throw new Error(`Missing trusted value for binding ${name}`);
      if (matches.has(key) && JSON.stringify(matches.get(key)) !== JSON.stringify(value)) throw new Error(`Ambiguous binding ${name}`);
      matches.set(key, value);
    }
    if (matches.size !== 1) throw new Error(`Binding ${name} requires exactly one native match; observed ${matches.size}`);
    result[name] = structuredClone([...matches.values()][0]);
  }
  return result;
}
export function resolveTurnInput(input: TaskInput, bindings: Readonly<Record<string, unknown>>): TaskInput {
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (typeof value !== 'object' || value === null) return value;
    if (Object.hasOwn(value, 'binding')) {
      const token = (value as { binding: string }).binding;
      const selected = ownPath(bindings, token.split('.'));
      if (selected === undefined) throw new Error(`Unavailable trusted binding ${token}`);
      return structuredClone(selected);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  }
  return visit(input) as TaskInput & { data?: DataValue };
}
