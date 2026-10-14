import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const route = z.object({
  purpose: z.enum(['extraction', 'proposals', 'decisions']),
  provider: z.enum(['codex-subscription', 'typesafe']), model: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  maxRequests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxSpendUsd: z.number().finite().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.purpose === 'decisions') !== (value.provider === 'typesafe') ||
    (value.provider === 'typesafe' && value.maxSpendUsd === undefined) ||
    (value.provider === 'codex-subscription' && value.maxSpendUsd !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Evaluator purpose requires an explicit supported budgeted provider' });
  }
});
const schema = z.object({ version: z.literal('paideia.evaluator-routes.v1'), routes: z.array(route).min(1).max(64),
  receiptPath: z.string().min(1).refine(isAbsolute),
}).strict().superRefine((value, ctx) => {
  const keys = value.routes.map(routeKey);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate evaluator route' });
});
export type EvaluatorRoute = z.infer<typeof route>;
export type EvaluatorPurpose = EvaluatorRoute['purpose'];
export function routeKey(value: Pick<EvaluatorRoute, 'purpose' | 'provider' | 'model'>): string {
  return `${value.purpose}:${value.provider}:${value.model}`;
}
export function readProtectedFile(file: string, maximum: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw Error('Invalid evaluator leaf file');
    const bytes = readFileSync(fd);
    if (bytes.length > maximum) throw Error('Invalid evaluator leaf file');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}
export function evaluatorPolicy() {
  const file = process.env.PAIDEIA_EVALUATOR_ROUTES_FILE;
  if (!file) return undefined;
  try { return schema.parse(JSON.parse(readProtectedFile(file, 64 * 1024))); }
  catch { throw Error('Invalid evaluator route policy'); }
}
export function evaluatorRoute(provider: string, purpose: EvaluatorPurpose, model: string) {
  const policy = evaluatorPolicy();
  const selected = policy?.routes.find(value => value.provider === provider && value.purpose === purpose && value.model === model);
  if (!selected) throw Error(`Capped training requires grok-broker admission; undeclared evaluator ${purpose} uses unsupported ${provider}`);
  return { route: selected, receiptPath: policy!.receiptPath };
}
