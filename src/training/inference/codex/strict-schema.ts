import { Ajv, type AnySchema } from 'ajv';
import { validateInferenceResponse } from '../response-schema.js';

type Schema = Record<string, unknown>;
const omitted = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'format']);
const maps = new Set(['properties', 'definitions', '$defs', 'patternProperties']);
const singles = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']);
const lists = new Set(['anyOf', 'oneOf', 'allOf']);
function object(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Translate schema nodes only: enum/const data and property names are not keywords. */
export function codexStrictSchema(schema: Schema): Schema {
  const result: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (omitted.has(key)) continue;
    if (maps.has(key) && object(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, transform(child)]));
    } else if (lists.has(key) && Array.isArray(value)) result[key] = value.map(transform);
    else if (singles.has(key)) result[key] = Array.isArray(value) ? value.map(transform) : transform(value);
    else result[key] = structuredClone(value);
  }
  if (schema['type'] === 'object' || object(schema['properties']) ||
    Array.isArray(schema['type']) && schema['type'].includes('object')) {
    const properties = (result['properties'] ?? {}) as Schema;
    const required = (schema['required'] ?? []) as string[];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) properties[key] = { anyOf: [properties[key], { type: 'null' }] };
    }
    result['properties'] = properties;
    result['required'] = Object.keys(properties);
    result['additionalProperties'] = false;
  }
  return result;
}
function transform(value: unknown): unknown {
  return object(value) ? codexStrictSchema(value) : value;
}

/** Remove only optional null placeholders; retain required nulls for original validation. */
export function normalizeCodexResponse(text: string, schema: Schema, jsonFence = false): string {
  // Check raw JSON before parsing/reserializing, so duplicate keys and infinities cannot disappear.
  validateInferenceResponse(text, {}, jsonFence);
  const json = jsonFence ? /^```json\r?\n([\s\S]*?)\r?\n```$/u.exec(text.trim())?.[1] ?? text : text;
  const ajv = new Ajv({ strict: true, strictRequired: false }).addSchema(schema as AnySchema, 'original');
  function visit(value: unknown, node: unknown, pointer: string): unknown {
    if (!object(node)) return value;
    if (typeof node['$ref'] === 'string') {
      const ref = node['$ref'];
      // Resolve local references through AJV, which also handles escaped JSON pointers.
      const target = ajv.getSchema(`original${ref}`);
      return visit(value, target!.schema, ref);
    }
    for (const keyword of ['anyOf', 'oneOf']) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const [index, branch] of branches.entries()) {
        const location = `${pointer}/${keyword}/${index}`;
        const candidate = visit(structuredClone(value), branch, location);
        if (ajv.getSchema(`original${location}`)!(candidate)) return candidate;
      }
    }
    if (Array.isArray(value) && node['items'] !== undefined) {
      return value.map((item, index) => visit(item,
        Array.isArray(node['items']) ? node['items'][index] : node['items'],
        `${pointer}/items${Array.isArray(node['items']) ? `/${index}` : ''}`));
    }
    if (object(value) && object(node['properties'])) {
      const required = (node['required'] ?? []) as string[];
      for (const [key, child] of Object.entries(node['properties'])) {
        if (!Object.hasOwn(value, key)) continue;
        if (value[key] === null && !required.includes(key)) delete value[key];
        else value[key] = visit(value[key], child, `${pointer}/properties/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      }
    }
    return value;
  }
  const normalized = JSON.stringify(visit(JSON.parse(json), schema, '#'));
  return normalized === JSON.stringify(JSON.parse(json)) ? text : normalized;
}
