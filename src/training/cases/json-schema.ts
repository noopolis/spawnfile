import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';

/** Shared authoring/runtime policy. `required` need not also declare properties. */
export function compileJsonSchema(schema: unknown): ValidateFunction {
  return new Ajv({ strict: true, strictRequired: false, allErrors: true }).compile(schema as AnySchema);
}
