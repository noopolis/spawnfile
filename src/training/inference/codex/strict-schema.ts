import { Ajv, type AnySchema } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import { InferenceFailure } from '../failure.js';
import { validateInferenceResponse } from '../response-schema.js';

type Schema = Record<string, unknown>;
// Wire schemas: graders/{labeling/planning,references/protocol,decomposition/transport},
// inference/decision/teacher and evaluation/semantic/protocol, plus local references.
const allowedKeywords = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', '$schema', '$ref', 'definitions', '$defs',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
]);
// These authored bounds remain enforced on the completed response by the provider.
const transportOmissions = new Set(['minimum', 'maximum', 'minLength', 'maxLength', '$schema']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function object(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
function refuse(keyword: string, pointer: string, reason = 'keyword is not allowlisted'): never {
  throw new InferenceFailure('unsupported', `Codex strict schema refuses ${keyword} at ${pointer}: ${reason}`);
}

/** Admit only the authored dialect. Literal data and property names are not schemas. */
function admit(schema: Schema): Map<string, Schema> {
  const locations = new Map<string, Schema>();
  inspect(schema, '#', locations);
  for (const [pointer, node] of locations) {
    const seen = new Set<string>();
    let target = node;
    while (typeof target['$ref'] === 'string') {
      const reference = target['$ref'];
      if (seen.has(reference)) refuse('$ref', `${pointer}/$ref`, 'reference-only cycles are unsupported');
      seen.add(reference);
      const resolved = locations.get(reference);
      if (!resolved) refuse('$ref', `${pointer}/$ref`, 'target must be a supported schema location');
      target = resolved;
    }
  }
  return locations;
}
function inspect(schema: unknown, pointer: string, locations: Map<string, Schema>): asserts schema is Schema {
  if (!object(schema)) refuse('schema', pointer, 'expected a schema object');
  locations.set(pointer, schema);
  // Check keys before their values: no unknown construct can hide an unvisited schema.
  for (const keyword of Object.keys(schema)) {
    if (!allowedKeywords.has(keyword)) refuse(keyword, `${pointer}/${escapePointer(keyword)}`);
  }
  for (const [keyword, value] of Object.entries(schema)) {
    const location = `${pointer}/${keyword}`;
    switch (keyword) {
      case 'definitions': case '$defs': case 'properties':
        if (!object(value)) refuse(keyword, location, 'expected a property map');
        for (const [name, child] of Object.entries(value)) inspect(child, `${location}/${escapePointer(name)}`, locations);
        break;
      case 'items':
        if (!object(value)) refuse(keyword, location, 'expected a single schema object; tuples are unsupported');
        inspect(value, location, locations);
        break;
      case '$ref':
        if (typeof value !== 'string' || (value !== '#' && !value.startsWith('#/')) ||
          value.includes('%') || /~(?![01])/u.test(value)) {
          refuse(keyword, location, 'expected an unscoped local JSON pointer without URI encoding');
        }
        if (Object.keys(schema).some(key => !['$ref', '$schema', 'description', 'definitions', '$defs'].includes(key))) {
          refuse(keyword, location, 'cannot preserve sibling validation constraints');
        }
        break;
      case 'additionalProperties':
        if (value !== false) refuse(keyword, location, 'free-form objects are unsupported; expected false');
        break;
      case 'type': {
        const valid = (type: unknown) => typeof type === 'string' && types.has(type);
        if (!valid(value) && !(Array.isArray(value) && value.length === 2 && value.includes('null') &&
          new Set(value).size === 2 && value.every(valid))) {
          refuse(keyword, location, 'expected a type or a nullable type pair');
        }
        break;
      }
      case 'required':
        if (!Array.isArray(value) || value.some(name => typeof name !== 'string') || new Set(value).size !== value.length) {
          refuse(keyword, location, 'expected distinct property names');
        }
        break;
      case 'description':
        if (typeof value !== 'string') refuse(keyword, location, 'expected text');
        break;
      case '$schema':
        if (value !== 'http://json-schema.org/draft-07/schema#') refuse(keyword, location, 'only draft-07 is supported');
        break;
      case 'enum':
        if (!Array.isArray(value) || value.length === 0) refuse(keyword, location, 'expected nonempty literal choices');
        break;
      case 'minimum': case 'maximum':
        if (typeof value !== 'number' || !Number.isFinite(value)) refuse(keyword, location, 'expected a finite number');
        break;
      case 'minLength': case 'maxLength': case 'minItems': case 'maxItems':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) refuse(keyword, location, 'expected a nonnegative integer');
        break;
      case 'uniqueItems':
        if (typeof value !== 'boolean') refuse(keyword, location, 'expected a boolean');
        break;
    }
  }
}

/** Translate admitted schema nodes only; do not forward arbitrary keywords. */
export function codexStrictSchema(schema: Schema): Schema {
  admit(schema);
  return transport(schema, new Set());
}
function transport(schema: Schema, nullableSlots: Set<string>): Schema {
  const references: Schema[] = [];
  const result = translate(schema, nullableSlots, '#', references);
  for (const node of references) {
    // Optional slots wrap their original target in anyOf[0], including ancestors.
    node['$ref'] = (node['$ref'] as string).split('/').map((part, index, parts) =>
      nullableSlots.has(parts.slice(0, index + 1).join('/')) ? `${part}/anyOf/0` : part).join('/');
  }
  return result;
}
function translate(schema: Schema, nullableSlots: Set<string>, pointer: string, references: Schema[], enclosingLiteral?: string): Schema {
  const literal = enclosingLiteral ?? ['enum', 'const', 'uniqueItems'].find(key => Object.hasOwn(schema, key));
  if (literal !== undefined && Object.hasOwn(schema, '$ref')) {
    refuse(literal, pointer, 'cannot preserve literal constraints with references');
  }
  const result: Schema = Object.fromEntries(Object.entries(schema).filter(([key]) => !transportOmissions.has(key))
    .map(([key, value]) => [key, structuredClone(value)]));
  if (typeof schema['$ref'] === 'string') references.push(result);
  for (const keyword of ['properties', 'definitions', '$defs']) {
    if (object(schema[keyword])) {
      result[keyword] = Object.fromEntries(Object.entries(schema[keyword]).map(([name, child]) =>
        [name, translate(child as Schema, nullableSlots, `${pointer}/${keyword}/${escapePointer(name)}`, references, literal)]));
    }
  }
  if (object(schema['items'])) result['items'] = translate(schema['items'], nullableSlots, `${pointer}/items`, references, literal);
  if (schema['type'] === 'object' || object(schema['properties']) || Object.hasOwn(schema, 'required') ||
    Object.hasOwn(schema, 'additionalProperties') || Array.isArray(schema['type']) && schema['type'].includes('object')) {
    const properties = (result['properties'] ?? {}) as Schema;
    const required = (schema['required'] ?? []) as string[];
    if (required.some(key => !Object.hasOwn(properties, key))) {
      refuse('required', `${pointer}/required`, 'every required name must be declared in properties');
    }
    if (schema['additionalProperties'] !== false) {
      refuse('additionalProperties', `${pointer}/additionalProperties`, 'free-form objects are unsupported; expected false');
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
  // Literal equality and uniqueness must not intersect a changed subtree.
  for (const keyword of ['enum', 'const', 'uniqueItems']) {
    if (Object.hasOwn(schema, keyword) && !isDeepStrictEqual(result, schema)) {
      refuse(keyword, `${pointer}/${keyword}`, 'cannot preserve literal constraints when translation changes their subtree');
    }
  }
  return result;
}

/** Remove transport-added null placeholders only; preserve every originally valid null. */
export function normalizeCodexResponse(text: string, schema: Schema, jsonFence = false): string {
  const locations = admit(schema);
  // Check raw JSON first so duplicate keys and infinities cannot disappear.
  validateInferenceResponse(text, {}, jsonFence);
  const json = jsonFence ? /^```json\r?\n([\s\S]*?)\r?\n```$/u.exec(text.trim())?.[1] ?? text : text;
  const nullableSlots = new Set<string>();
  transport(schema, nullableSlots);
  const ajv = new Ajv({ strict: true, strictRequired: false }).addSchema(schema as AnySchema, 'original');
  function visit(value: unknown, node: Schema, pointer: string): unknown {
    if (typeof node['$ref'] === 'string') {
      const reference = node['$ref'];
      return visit(value, locations.get(reference)!, reference);
    }
    if (Array.isArray(value) && object(node['items'])) {
      return value.map(item => visit(item, node['items'] as Schema, `${pointer}/items`));
    }
    if (object(value) && object(node['properties'])) {
      for (const [key, child] of Object.entries(node['properties'])) {
        if (!Object.hasOwn(value, key)) continue;
        const location = `${pointer}/properties/${escapePointer(key)}`;
        // Encode each pointer segment so percent/hash property names stay literal.
        const uri = location.split('/').map(encodeURIComponent).join('/').replace('%23', '#');
        if (value[key] === null && nullableSlots.has(location) && !ajv.getSchema(`original${uri}`)!(null)) delete value[key];
        else value[key] = visit(value[key], child as Schema, location);
      }
    }
    return value;
  }
  const normalized = JSON.stringify(visit(JSON.parse(json), schema, '#'));
  return normalized === JSON.stringify(JSON.parse(json)) ? text : normalized;
}
