import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { evaluatorPolicy, evaluatorRoute, readProtectedFile, type EvaluatorRoute } from './policy.js';
import { reserveEvaluatorRequest } from './ledger.js';
import { budgetEvaluatorInference, typeSafeEvaluatorEnvironment } from './provider.js';
import { assertModelRequestAdmission } from '../request-cap.js';
import { createTypeSafeDecision } from '../decision/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const extraction: EvaluatorRoute = { purpose: 'extraction', provider: 'codex-subscription', model: 'codex-test', maxRequests: 2 };
const decisions: EvaluatorRoute = { purpose: 'decisions', provider: 'typesafe', model: 'jev-1.0.0', maxRequests: 2, maxSpendUsd: 1 };
async function fixture(routes = [extraction, decisions]) {
  const root = await mkdtemp(join(tmpdir(), 'evaluator-')); roots.push(root);
  const policy = join(root, 'policy.json'), receiptPath = join(root, 'receipts.jsonl');
  const document = { version: 'paideia.evaluator-routes.v1', routes, receiptPath };
  await writeFile(policy, JSON.stringify(document));
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker'); vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', policy);
  const receipts = async () => (await readFile(receiptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, policy, receiptPath, document, receipts };
}
const fake = (): InferenceProvider => ({ id: 'fake', capabilities: { tools: 'contained', billing: 'subscription', temperature: false, seed: false },
  generate: vi.fn(async request => ({ text: 'answer', model: request.model, route: 'subscription', usage: null })) });

it('keeps separate run ledgers independent while preserving exhaustion and policy checks on same-run resume', async () => {
  const a = await fixture([{ ...extraction, maxRequests: 1 }]);
  reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model).finish('completed');
  const b = await fixture([{ ...extraction, maxRequests: 2 }]);
  reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model).finish('completed');
  expect(await a.receipts()).toHaveLength(2);
  expect(await b.receipts()).toHaveLength(2);
  vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', a.policy);
  expect(() => reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model)).toThrow('request cap');
  await writeFile(a.policy, JSON.stringify({ ...a.document, routes: [{ ...extraction, maxRequests: 2 }] }));
  expect(() => reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model)).toThrow('changed on resume');
  vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', b.policy);
  reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model).finish('completed');
  expect(() => reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model)).toThrow('request cap');
});

it('admits only exact explicitly budgeted purposes, providers and models; broker remains independent', async () => {
  vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', undefined); expect(evaluatorPolicy()).toBeUndefined();
  await fixture();
  expect(() => assertModelRequestAdmission('codex-subscription', 'extract', { purpose: 'extraction', model: extraction.model })).not.toThrow();
  expect(() => assertModelRequestAdmission('typesafe', 'decide', { purpose: 'decisions', model: decisions.model })).not.toThrow();
  for (const [provider, purpose, model] of [['codex-subscription', 'proposals', extraction.model], ['codex-subscription', 'extraction', 'other'],
    ['ollama', 'extraction', extraction.model], ['grok-subscription', 'extraction', extraction.model]] as const) {
    expect(() => evaluatorRoute(provider, purpose, model)).toThrow('undeclared evaluator');
  }
  expect(() => assertModelRequestAdmission('native-grader', 'grader')).toThrow('unsupported native-grader');
  expect(() => assertModelRequestAdmission('codex-subscription', 'judge')).toThrow('unsupported codex-subscription');
  expect(() => assertModelRequestAdmission('grok-broker', 'subject')).not.toThrow();
});

it.each([
  { ...extraction, maxRequests: 0 }, { ...extraction, maxSpendUsd: 1 }, { ...decisions, maxSpendUsd: undefined },
  { ...decisions, purpose: 'proposals' }, { ...extraction, provider: 'typesafe' }, { ...extraction, model: '../secret' },
  { ...extraction, arbitrary: true },
])('rejects malformed evaluator grant %j', async invalid => {
  const f = await fixture(); await writeFile(f.policy, JSON.stringify({ ...f.document, routes: [invalid] }));
  expect(evaluatorPolicy).toThrow('Invalid evaluator route policy');
});

it('rejects duplicate routes, missing/oversized/malformed policy and unsafe secret leaves without leaking bytes', async () => {
  const f = await fixture([extraction, extraction]); expect(evaluatorPolicy).toThrow('Invalid evaluator route policy');
  await writeFile(f.policy, '{'); expect(evaluatorPolicy).toThrow('Invalid evaluator route policy');
  await writeFile(f.policy, 'x'.repeat(65537)); expect(evaluatorPolicy).toThrow('Invalid evaluator route policy');
  await rm(f.policy); expect(evaluatorPolicy).toThrow('Invalid evaluator route policy');
  expect(() => readProtectedFile(f.root, 100)).toThrow('Invalid evaluator leaf file');
  const secret = join(f.root, 'secret'); await writeFile(secret, 'PRIVATE_MARKER');
  const alias = join(f.root, 'hardlink'); await link(secret, alias);
  expect(() => readProtectedFile(secret, 16384)).toThrow('Invalid evaluator leaf file'); await rm(alias);
  const linkPath = join(f.root, 'link'); await symlink(secret, linkPath);
  vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', linkPath); expect(typeSafeEvaluatorEnvironment).toThrow('Invalid evaluator TypeSafe secret file');
  vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', secret);
  for (const bad of ['', 'PRIVATE\nMARKER', '\0PRIVATE']) { await writeFile(secret, bad); expect(typeSafeEvaluatorEnvironment).toThrow('Invalid evaluator TypeSafe secret file'); }
  await writeFile(secret, 'x'.repeat(16385)); expect(typeSafeEvaluatorEnvironment).toThrow('Invalid evaluator TypeSafe secret file');
  vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', undefined); expect(typeSafeEvaluatorEnvironment()).toBeUndefined();
});

it('charges before dispatch; concurrent, failed and interrupted attempts survive fresh construction and resume', async () => {
  const f = await fixture(); const provider = fake();
  provider.generate = vi.fn(async () => { throw Error('PRIVATE_MARKER'); });
  const wrapped = budgetEvaluatorInference(provider, extraction.provider, 'extraction', extraction.model);
  await expect(wrapped.generate({ model: 'other', prompt: 'x' })).rejects.toThrow('differs');
  await expect(wrapped.generate({ model: extraction.model, prompt: 'x', signal: AbortSignal.abort() })).rejects.toThrow();
  expect(provider.generate).not.toHaveBeenCalled();
  await expect(wrapped.generate({ model: extraction.model, prompt: 'x' })).rejects.toThrow('PRIVATE_MARKER');
  expect((await f.receipts())[0].event, 'admission receipt exists before dispatch').toBe('admitted');
  reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model); // simulated crash after admission
  await expect(budgetEvaluatorInference(fake(), extraction.provider, 'extraction', extraction.model).generate({ model: extraction.model, prompt: 'x' })).rejects.toThrow('request cap');
  expect(await f.receipts()).toMatchObject([{ event: 'admitted' }, { event: 'failed' }, { event: 'admitted' }]);
  expect(await readFile(f.receiptPath, 'utf8')).not.toContain('PRIVATE_MARKER');
  await writeFile(f.policy, JSON.stringify({ ...f.document, routes: [{ ...extraction, maxRequests: 3 }] }));
  expect(() => reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model)).toThrow('changed on resume');
});

it('persists success/failure measured accounting and rejects corrupted, duplicate or unmatched receipts', async () => {
  const f = await fixture(); const provider = fake();
  provider.generate = vi.fn(async request => ({ text: 'ok', model: request.model, route: 'subscription',
    usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, source: 'native' } }));
  const wrapped = budgetEvaluatorInference(provider, extraction.provider, 'extraction', extraction.model);
  expect((await wrapped.generate({ model: extraction.model, prompt: 'private prompt' })).text).toBe('ok');
  expect((await f.receipts())[1]).toMatchObject({ inputTokens: 5, outputTokens: 2, event: 'completed' });
  expect(await readFile(f.receiptPath, 'utf8')).not.toContain('private prompt');
  const first = (await f.receipts())[0];
  for (const [items, reason] of [[[first, first], 'Duplicate'], [[{ ...first, event: 'completed' }], 'Invalid evaluator completion']] as const) {
    await writeFile(f.receiptPath, items.map(item => JSON.stringify(item)).join('\n') + '\n');
    expect(() => reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model)).toThrow(reason);
  }
  await writeFile(f.receiptPath, '{'); expect(() => reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model)).toThrow();
  await rm(f.receiptPath); await symlink(f.policy, f.receiptPath);
  expect(() => reserveEvaluatorRequest(extraction.provider, 'extraction', extraction.model)).toThrow();
  expect(() => reserveEvaluatorRequest(decisions.provider, 'decisions', decisions.model, NaN)).toThrow('Invalid evaluator spend');
});

it('enforces independent spend ceilings, conservative unknown usage, and zero budgets', async () => {
  const f = await fixture([{ ...decisions, maxRequests: 10, maxSpendUsd: 0.5 }]);
  const admission = reserveEvaluatorRequest('typesafe', 'decisions', decisions.model, 0.2);
  admission.finish('failed', { inputTokens: -1, outputTokens: NaN, usd: 0.4 });
  expect((await f.receipts())[1]).toMatchObject({ inputTokens: null, outputTokens: null, chargedUsd: 0.4 });
  expect(() => reserveEvaluatorRequest('typesafe', 'decisions', decisions.model, 0.2)).toThrow('spend cap');
  const zero = await fixture([{ ...decisions, maxSpendUsd: 0 }]);
  expect(() => reserveEvaluatorRequest('typesafe', 'decisions', decisions.model, 0)).toThrow('spend cap');
  expect(await readFile(zero.receiptPath, 'utf8')).toBe('');
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', undefined); vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', undefined); const provider = fake();
  expect(budgetEvaluatorInference(provider, 'ollama', 'proposals', 'x')).toBe(provider);
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker');
  expect(budgetEvaluatorInference(provider, 'grok-broker', 'proposals', 'x')).toBe(provider);
});

it('loads the key only into evaluator transport and budgets every retry without raw key/payload/error receipts', async () => {
  const f = await fixture([decisions]); const secret = join(f.root, 'secret');
  await writeFile(secret, ' PRIVATE_MARKER \n'); vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', secret);
  vi.stubEnv('TYPESAFE_API_KEY', undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer PRIVATE_MARKER' });
    throw Error('PRIVATE_MARKER');
  });
  expect(() => createTypeSafeDecision({ model: decisions.model, endpoint: 'https://other.invalid/v1', fetch })).toThrow('declared hosted endpoint');
  const backend = createTypeSafeDecision({ model: decisions.model, fetch, retryBaseMs: 0, maxAttempts: 3 });
  const request = { key: 'one', projection: { text: 'private input' }, type: 'noul' as const, optionLabels: ['true', 'false'], expectedOptions: ['true'], instructions: 'Is it supported?' };
  await expect(backend.score([request])).rejects.toThrow('request cap');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(process.env.TYPESAFE_API_KEY).toBeUndefined();
  const stored = await f.receipts(); expect(stored).toHaveLength(4);
  expect(stored.every(item => item.reservedUsd > 0)).toBe(true);
  expect(backend.requestReceipts!().map(item => item.requestId)).toEqual(stored.filter(item => item.event === 'admitted').map(item => item.id));
  expect(JSON.stringify(stored)).not.toMatch(/PRIVATE_MARKER|private input/);
});


it('retains allowlisted failed-provider usage and propagates completion-write failure without false receipts', async () => {
  const f = await fixture([{ ...extraction, maxRequests: 10 }]), provider = fake();
  const wrapped = budgetEvaluatorInference(provider, extraction.provider, 'extraction', extraction.model);
  for (const error of [{ usage: { inputTokens: 3, outputTokens: 1 }, secret: 'PRIVATE_MARKER' }, null, { usage: 42 }]) {
    provider.generate = vi.fn(async () => { throw error; });
    await expect(wrapped.generate({ model: extraction.model, prompt: 'x' })).rejects.toEqual(error);
  }
  expect((await f.receipts())[1]).toMatchObject({ event: 'failed', inputTokens: 3, outputTokens: 1 });
  expect(await readFile(f.receiptPath, 'utf8')).not.toContain('PRIVATE_MARKER');
  provider.generate = vi.fn(async request => {
    await rm(f.receiptPath); await symlink(f.policy, f.receiptPath);
    return { text: 'x', model: request.model, route: 'subscription', usage: null };
  });
  await expect(wrapped.generate({ model: extraction.model, prompt: 'x' })).rejects.toThrow();
  expect(JSON.parse(await readFile(f.policy, 'utf8')).version).toBe('paideia.evaluator-routes.v1');
});


it('serializes concurrent evaluator admission against one shared request budget', async () => {
  const f = await fixture([{ ...extraction, maxRequests: 1 }]), provider = fake();
  const first = budgetEvaluatorInference(provider, extraction.provider, 'extraction', extraction.model);
  const second = budgetEvaluatorInference(provider, extraction.provider, 'extraction', extraction.model);
  const result = await Promise.allSettled([first, second].map(route => route.generate({ model: extraction.model, prompt: 'x' })));
  expect(result.map(item => item.status)).toEqual(['fulfilled', 'rejected']);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(await f.receipts()).toHaveLength(2);
});


it('enforces an explicitly supplied evaluator policy even without a subject broker cap', async () => {
  await fixture([{ ...extraction, maxRequests: 1 }, { ...decisions, maxRequests: 1 }]);
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', undefined);
  expect(() => assertModelRequestAdmission('codex-subscription', 'extract', { purpose: 'extraction', model: 'other' })).toThrow('undeclared evaluator');
  const provider = fake(), route = budgetEvaluatorInference(provider, extraction.provider, 'extraction', extraction.model);
  await route.generate({ model: extraction.model, prompt: 'x' });
  await expect(route.generate({ model: extraction.model, prompt: 'x' })).rejects.toThrow('request cap');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ model: decisions.model, answers: { q: { type: 'noul', noul: 1 } } }));
  const backend = createTypeSafeDecision({ model: decisions.model, env: { TYPESAFE_API_KEY: 'synthetic-key' }, fetch });
  const request = { key: 'q', type: 'noul' as const, optionLabels: ['true', 'false'], instructions: 'Supported?', projection: {} };
  await backend.score([request]); await expect(backend.score([request])).rejects.toThrow('request cap');
  expect(fetch).toHaveBeenCalledTimes(1);
});
