import { Ajv, type AnySchema } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
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
  rejectUnsupportedConstraints(schema);
  return translate(schema, new Set(), '#');
}
// Required null placeholders count as properties, even when they decode to absence.
// Refuse count limits across schema nodes, including constraints reached by references.
function rejectUnsupportedConstraints(schema: unknown): void {
  if (!object(schema)) return;
  // Slot identities are structural JSON pointers, not URI anchors or scoped IDs.
  if (Object.hasOwn(schema, '$id') || typeof schema['$ref'] === 'string' &&
    (schema['$ref'] !== '#' && !schema['$ref'].startsWith('#/') || schema['$ref'].includes('%'))) {
    throw new InferenceFailure('unsupported', 'Codex strict schema requires unscoped local JSON pointer references without URI encoding');
  }
  if (Object.hasOwn(schema, 'maxProperties')) {
    throw new InferenceFailure('unsupported', 'Codex strict schema cannot preserve maxProperties with required transport slots');
  }
  for (const [key, value] of Object.entries(schema)) {
    if ((maps.has(key) || key === 'dependencies') && object(value)) {
      for (const child of Object.values(value)) rejectUnsupportedConstraints(child);
    } else if (singles.has(key) || lists.has(key) || key === 'additionalItems') {
      if (Array.isArray(value)) value.forEach(rejectUnsupportedConstraints);
      else rejectUnsupportedConstraints(value);
    }
  }
  // Presence predicates see required null slots as present, even when decoding
  // would remove them. Refuse conservatively, including through references.
  for (const keyword of ['dependencies', 'propertyNames']) {
    if (Object.hasOwn(schema, keyword)) {
      throw new InferenceFailure('unsupported', `Codex strict schema cannot preserve ${keyword} with required transport slots`);
    }
  }
}
function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
function translate(schema: Schema, nullableSlots: Set<string>, pointer: string, enclosingComposition?: string): Schema {
  const composition = enclosingComposition ?? ['oneOf', 'allOf', 'not', 'enum', 'const', 'if', 'then', 'else'].find(key => Object.hasOwn(schema, key));
  // Negation, literal equality and conditionals make otherwise widening rewrites unsafe.
  // These constraints cannot be repaired after inference.
  // References may target translated nodes outside this subtree, so refuse them too.
  if (composition !== undefined && typeof schema['$ref'] === 'string') {
    throw new InferenceFailure('unsupported', `Codex strict schema cannot preserve ${composition} with references`);
  }
  const transform = (value: unknown, location: string): unknown =>
    object(value) ? translate(value, nullableSlots, location, composition) : value;
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
  if (composition !== undefined && !isDeepStrictEqual(result, schema)) {
    throw new InferenceFailure('unsupported', `Codex strict schema cannot preserve ${composition} when translation changes its constraints`);
  }
  return result;
}

/** Remove transport-added null placeholders only; preserve every originally valid null. */
export function normalizeCodexResponse(text: string, schema: Schema, jsonFence = false): string {
  rejectUnsupportedConstraints(schema);
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
      const candidates = new Map<string, unknown>();
      for (const [index, branch] of branches.entries()) {
        const location = `${pointer}/${keyword}/${index}`;
        const candidate = visit(structuredClone(value), branch, location);
        if (ajv.getSchema(`original${pointer}`)!(candidate)) candidates.set(JSON.stringify(candidate), candidate);
      }
      if (candidates.size > 1) throw new InferenceFailure('unsupported', 'Codex null placeholders have ambiguous union interpretations');
      if (candidates.size === 1) return candidates.values().next().value;
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
