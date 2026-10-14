import { expect, test } from 'vitest';
import { z } from 'zod';
import { createGradeResultSchema } from './schema.js';

const digest = 'a'.repeat(64);
const result = { status: 'unknown', score: 0, coverage: 0,
  gates: [{ id: 'gate', status: 'unknown' }],
  questions: [{ id: 'q', score: 0, instances: 1, not_applicable: 0, escalated: 0, missing: 1 }],
  identity: { calibration: { expansion: [], questions: { q: digest }, promptTemplateVersion: 'v1', segmenter: 'test',
    optionMapping: { q: digest }, backendModel: 'test', golden: digest, seed: 's', exclusions: [],
    escalation: digest, escalationTeacher: digest, uncalibrated: 'refuse' },
  calibrationDigest: digest, escalation: digest, teacherPolicy: digest, scoringPolicy: digest },
  backendBilling: 'local', judgeCalls: [] };

test('grading persistence retains explicit identity and missing coverage, validating its supplied call schema', () => {
  const schema = createGradeResultSchema(z.never());
  expect(schema.parse(result)).toEqual(result);
  expect(() => schema.parse({ ...result, judgeCalls: [{}] })).toThrow();
  expect(() => schema.parse({ ...result, invented: 'not supported' })).toThrow();
  expect(() => schema.parse({ ...result, coverage: 1.1 })).toThrow();
  expect(() => schema.parse({ ...result, identity: { ...result.identity, calibrationDigest: 'unbound' } })).toThrow();
});

test('persists explicit API accounting and spend-cap reasons without accepting unknown receipt fields', () => {
  const schema = createGradeResultSchema(z.never());
  const receipt = { billing: 'api', model: 'jev-1.13.0', endpoint: 'https://example.test', inputTokens: 10,
    outputTokens: 0, usd: 0.001, estimatedInputTokens: 20, estimatedUsd: 0.002, latencyMs: 5, status: 200 };
  const api = { ...result, backendBilling: 'api', decisions: [{ instance: 'q', model: 'default', status: 'missing', reason: 'spend cap' }],
    decisionAccounting: { billing: 'api', requests: 1, inputTokens: 10, outputTokens: 0, usd: 0.001,
      latencyMs: { p50: 5, p95: 5 }, receipts: [receipt] } };
  expect(schema.parse(api)).toEqual(api);
  const identified = { ...api, decisionAccounting: { ...api.decisionAccounting, receipts: [{ ...receipt, requestId: 'origin' }] } };
  expect(schema.parse(identified)).toEqual(identified);
  expect(() => schema.parse({ ...api, decisionAccounting: { ...api.decisionAccounting, receipts: [{ ...receipt, requestId: '' }] } })).toThrow();
  expect(() => schema.parse({ ...api, decisionAccounting: { ...api.decisionAccounting, receipts: [{ ...receipt, Authorization: 'secret' }] } })).toThrow();
});
