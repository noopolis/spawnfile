import { Ajv, type AnySchema } from 'ajv';
import { InferenceFailure } from '../failure.js';
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
  return translate(schema, new Set(), '#');
}
function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
function translate(schema: Schema, nullableSlots: Set<string>, pointer: string): Schema {
  const transform = (value: unknown, location: string): unknown =>
    object(value) ? translate(value, nullableSlots, location) : value;
  const result: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (omitted.has(key)) continue;
    if (maps.has(key) && object(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, transform(child, `${pointer}/${key}/${escapePointer(name)}`)]));
    } else if (lists.has(key) && Array.isArray(value)) result[key] = value.map((child, index) => transform(child, `${pointer}/${key}/${index}`));
    else if (singles.has(key)) result[key] = Array.isArray(value) ? value.map((child, index) => transform(child, `${pointer}/${key}/${index}`)) : transform(value, `${pointer}/${key}`);
    else result[key] = structuredClone(value);
  }
  if (schema['type'] === 'object' || object(schema['properties']) ||
    Array.isArray(schema['type']) && schema['type'].includes('object')) {
    const properties = (result['properties'] ?? {}) as Schema;
    const required = (schema['required'] ?? []) as string[];
    if (required.some(key => !Object.hasOwn(properties, key))) {
      throw new InferenceFailure('unsupported', 'Codex strict schema requires every required name to be declared in properties');
    }
    if (schema['additionalProperties'] !== false ||
      object(schema['patternProperties']) && Object.keys(schema['patternProperties']).length > 0) {
      throw new InferenceFailure('unsupported', 'Codex strict schema cannot represent free-form objects; declare properties and additionalProperties: false');
    }
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) {
        properties[key] = { anyOf: [properties[key], { type: 'null' }] };
        nullableSlots.add(`${pointer}/properties/${escapePointer(key)}`);
      }
    }
    result['properties'] = properties;
    result['required'] = Object.keys(properties);
    result['additionalProperties'] = false;
  }
  return result;
}

/** Remove transport-added null placeholders only; preserve every originally valid null. */
export function normalizeCodexResponse(text: string, schema: Schema, jsonFence = false): string {
  // Check raw JSON before parsing/reserializing, so duplicate keys and infinities cannot disappear.
  validateInferenceResponse(text, {}, jsonFence);
  const json = jsonFence ? /^```json\r?\n([\s\S]*?)\r?\n```$/u.exec(text.trim())?.[1] ?? text : text;
  const nullableSlots = new Set<string>();
  translate(schema, nullableSlots, '#');
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
      // A later branch may accept an explicit null that an earlier branch would erase.
      if (ajv.getSchema(`original${pointer}`)!(value)) return value;
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
      for (const [key, child] of Object.entries(node['properties'])) {
        if (!Object.hasOwn(value, key)) continue;
        const location = `${pointer}/properties/${escapePointer(key)}`;
        if (value[key] === null && nullableSlots.has(location) && !ajv.getSchema(`original${location}`)!(null)) delete value[key];
        else value[key] = visit(value[key], child, location);
      }
    }
    return value;
  }
  const normalized = JSON.stringify(visit(JSON.parse(json), schema, '#'));
  return normalized === JSON.stringify(JSON.parse(json)) ? text : normalized;
}
