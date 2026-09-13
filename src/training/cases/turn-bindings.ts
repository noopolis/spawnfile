import { Environment } from '@marcbachmann/cel-js';
import { fail, fields, object, oneOf, string } from './validation.js';

export function validatePredicate(value: unknown, variables: readonly string[], path: string): void {
  const source = string(value, path);
  if (source.length > 16_000) fail(path, 'predicate exceeds 16000 characters');
  const environment = new Environment();
  for (const variable of variables) environment.registerVariable(variable, 'map');
  const result = environment.check(source);
  if (!result.valid) fail(path, `invalid CEL predicate: ${result.error?.message ?? 'unsupported expression'}`);
  if (!['bool', 'dyn'].includes(result.type ?? '')) fail(path, 'CEL predicate must produce a boolean');
}
export function bindingShape(value: unknown, path: string): void {
  const bindings = object(value, path);
  if (!Object.keys(bindings).length) fail(path, 'expected at least one binding');
  for (const [name, declaration] of Object.entries(bindings)) {
    const location = `${path}.${name}`;
    if (!/^[A-Za-z_][\w-]*$/.test(name)) fail(location, 'invalid binding name');
    const binding = object(declaration, location);
    fields(binding, ['event', 'where', 'distinct', 'cardinality', 'value'], location);
    oneOf(binding.event, ['tool.dispatch', 'tool.complete', 'output'], `${location}.event`);
    oneOf(binding.distinct, ['event.id', 'call.id'], `${location}.distinct`);
    oneOf(binding.cardinality, ['one'], `${location}.cardinality`);
    if (binding.event === 'output' && binding.distinct === 'call.id') fail(location, 'output events have no call identity');
    const selector = string(binding.value, `${location}.value`);
    if (!/^(event|call)(\.[A-Za-z_][\w-]*)+$/.test(selector) ||
      (binding.event === 'output' && selector.startsWith('call.'))) fail(location, 'unsupported typed observation selector');
    if (binding.where !== undefined) {
      const where = object(binding.where, `${location}.where`);
      fields(where, ['cel'], `${location}.where`);
      validatePredicate(where.cel, binding.event === 'output' ? ['event', 'context'] : ['event', 'call', 'context'], `${location}.where.cel`);
    }
  }
}
export function validateBindingReferences(value: unknown, available: ReadonlySet<string>, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateBindingReferences(item, available, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>;
    if (Object.hasOwn(map, 'binding')) {
      fields(map, ['binding'], path);
      const reference = string(map.binding, `${path}.binding`);
      if (!/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(reference) || !available.has(reference.split('.')[0]!)) {
        fail(path, `binding must reference an earlier turn declaration: ${reference}`);
      }
    } else {
      for (const [key, item] of Object.entries(map)) validateBindingReferences(item, available, `${path}.${key}`);
    }
  }
}
