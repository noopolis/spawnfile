import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { InferenceFailure } from './failure.js';

type ResponseSchema = Readonly<Record<string, unknown>> | undefined;

function compile(schema: Exclude<ResponseSchema, undefined>): ValidateFunction {
  try {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Expected an object schema');
    const data = z.json().parse(schema);
    if (Buffer.byteLength(JSON.stringify(data)) > 65_536) throw new Error('Schema exceeds its transport bound');
    const validate = new Ajv({ strict: true, strictRequired: false, allErrors: false }).compile(data as AnySchema);
    if ('$async' in validate) throw new Error('Async schemas are unsupported');
    return validate;
  } catch {
    throw new InferenceFailure('unsupported', 'Response schema must be a synchronous JSON Schema draft-07 object with locally resolvable references (at most 64 KiB)');
  }
}

/** Reject unsupported controls before calling a model; never fetch external schemas. */
export function validateInferenceSchema(schema: ResponseSchema): void {
  if (schema !== undefined) compile(schema);
}

/** Default strict JSON; extraction may explicitly permit a single json fence. */
export function validateInferenceResponse(text: string, schema: ResponseSchema, jsonFence = false): void {
  if (schema === undefined) return;
  const validate = compile(schema);
  try {
    if (jsonFence) text = /^```json\r?\n([\s\S]*?)\r?\n```$/u.exec(text.trim())?.[1] ?? text;
    const value: unknown = JSON.parse(text);
    if (parseDocument(text, { uniqueKeys: true }).errors.length || !validate(value)) throw new Error('Invalid structured response');
    z.json().parse(value);
  } catch {
    throw new InferenceFailure('protocol', 'Completed inference response does not match its requested JSON schema');
  }
}
