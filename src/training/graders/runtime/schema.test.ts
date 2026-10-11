import { expect, test } from 'vitest';
import { z } from 'zod';
import { createGradeResultSchema } from './schema.js';

const digest = 'a'.repeat(64);
const result = { status: 'unknown', score: 0, coverage: 0,
  gates: [{ id: 'gate', status: 'unknown' }],
  questions: [{ id: 'q', score: 0, instances: 1, not_applicable: 0, escalated: 0, missing: 1 }],
  identity: { calibration: { questions: { q: digest }, promptTemplateVersion: 'v1', segmenter: 'test',
    optionMapping: { q: digest }, backendModel: 'test', golden: digest, seed: 's', exclusions: [] },
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
