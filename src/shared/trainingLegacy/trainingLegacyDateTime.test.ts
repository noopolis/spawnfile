import { expect, test } from 'vitest';
import { compatibleIsoDateTimeSchema } from './index.js';

const offsetSchema = compatibleIsoDateTimeSchema({ offset: true });
const utcSchema = compatibleIsoDateTimeSchema();

test.each([
  '2026-10-27T12:34Z',
  '2026-10-27T12:34:00Z',
  '2026-10-27T12:34:00.123456789Z',
  '2024-02-29T00:00Z',
])('preserves the accepted UTC timestamp %s unchanged', value => {
  expect(utcSchema.parse(value)).toBe(value);
  expect(offsetSchema.parse(value)).toBe(value);
});

test.each([
  '2026-10-27T12:34+02:00',
  '2026-10-27T12:34:00-02:30',
  '2026-10-27T12:34:00.123+00:00',
])('preserves explicit offset policy for %s', value => {
  expect(offsetSchema.parse(value)).toBe(value);
  expect(utcSchema.safeParse(value).success).toBe(false);
});

test.each([
  '2026-02-29T12:34Z',
  '2026-02-30T12:34:00Z',
  '2026-10-27T12:34',
  '2026-10-27T12:34:00',
  '2026-10-27T12:34+24:00',
  '2026-10-27T12:34+02:60',
  '2026-10-27T24:00Z',
  '2026-10-27T12:34:60Z',
  '2026-10-27T12:34.5Z',
  '2026-10-27T12:34+0200',
])('continues rejecting invalid or local timestamp %s', value => {
  expect(offsetSchema.safeParse(value).success).toBe(false);
  expect(utcSchema.safeParse(value).success).toBe(false);
});
