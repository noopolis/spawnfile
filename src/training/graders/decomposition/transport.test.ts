import { expect, it } from 'vitest';
import { extractionResponseSchema, parseExtractionResponse } from './index.js';

it('accepts bare JSON and exactly one json fence, retaining strict unit schema', () => {
  const payload = { units: [{ id: 'u', kind: 'claim', text: 'Visible claim' }] };
  for (const text of [JSON.stringify(payload), ` \n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n `]) {
    expect(parseExtractionResponse(text)).toEqual(payload);
    expect(parseExtractionResponse(text.replaceAll('\n', '\r\n'))).toEqual(payload);
  }
  expect(extractionResponseSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: ['units'], properties: { units: { type: 'array', items: { additionalProperties: false } } } });
});

it('rejects other decoration, YAML, duplicate keys and unknown metadata', () => {
  for (const text of ['```\n{"units":[]}\n```', '```JSON\n{"units":[]}\n```',
    'Prose\n```json\n{"units":[]}\n```', '```json\n{"units":[]}\n```\ntrailing',
    '```json\n```json\n{"units":[]}\n```\n```', 'units: []',
    '{"units":[],"units":[]}', '{"units":[],"extra":true}',
    '{"units":[{"id":"u","kind":"claim","text":"x","extra":true}]}']) {
    expect(() => parseExtractionResponse(text)).toThrow();
  }
});
