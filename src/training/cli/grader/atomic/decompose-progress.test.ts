import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runDecompose } from './decompose.js';
import { fixture } from './fixtures.js';

async function checkpoint(directory: string) {
  const name = (await readdir(directory)).find(file => file.endsWith('.checkpoint.json'))!;
  return JSON.parse(await readFile(join(directory, name), 'utf8'));
}
it('persists malformed extraction receipts before parsing and retries malformed responses on resume', async () => {
  const f = await fixture();
  f.generate.mockResolvedValue({ text: 'malformed', model: 'actual', route: 'subscription', usage: { inputTokens: 1, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, source: 'provider' }, attempts: [] });
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow();
  const saved = await checkpoint(f.decompose.out);
  expect(saved.receipts).toHaveLength(1);
  expect(saved.receipts[0]).toMatchObject({ response_text: 'malformed', outcome: 'invalid-response', usage: { inputTokens: 1, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, source: 'provider' }, attempts: [] });
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow();
  expect(f.generate).toHaveBeenCalledTimes(2);
});
it('persists cancellation accounting and resumes only the missing audit', async () => {
  const f = await fixture(), controller = new AbortController();
  f.generate.mockResolvedValueOnce({ text: JSON.stringify({ units: [f.unit] }), model: 'actual', route: 'subscription', usage: null })
    .mockImplementationOnce(async () => { controller.abort(); throw { responseModel: 'actual', usage: { costUsd: 2 } }; });
  await expect(runDecompose({ ...f.decompose, signal: controller.signal }, f.dependencies)).rejects.toEqual({ responseModel: 'actual', usage: { costUsd: 2 } });
  const saved = await checkpoint(f.decompose.out);
  expect(saved.receipts.map((receipt: { outcome: string }) => receipt.outcome)).toEqual(['completed', 'cancelled']);
  expect(saved.receipts[1]).toMatchObject({ usage: { costUsd: 2 }, reported_model: 'actual' });
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1 });
  expect(f.generate).toHaveBeenCalledTimes(3);
  expect((await checkpoint(f.decompose.out)).receipts).toHaveLength(3);
});
it('resumes a response received with cancellation without repeating the extraction', async () => {
  const f = await fixture(), controller = new AbortController();
  f.generate.mockImplementationOnce(async () => {
    controller.abort();
    return { text: JSON.stringify({ units: [f.unit] }), model: 'actual', route: 'subscription', usage: null };
  });
  await expect(runDecompose({ ...f.decompose, signal: controller.signal }, f.dependencies)).rejects.toThrow();
  expect((await checkpoint(f.decompose.out)).receipts[0].outcome).toBe('received');
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1 });
  expect(f.generate).toHaveBeenCalledTimes(2);
});
it.each(['\n', '\r\n'])('requests a strict response schema and accepts one surrounding JSON fence (%j)', async newline => {
  const f = await fixture();
  f.generate.mockResolvedValueOnce({ text: ['```json', JSON.stringify({ units: [f.unit] }), '```'].join(newline), model: 'actual', route: 'subscription', usage: null });
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1, rejected: 0 });
  expect(f.generate.mock.calls.every(([request]) => request.responseJsonFence === true)).toBe(true);
  expect(f.generate.mock.calls[0]![0].responseSchema).toMatchObject({ type: 'object', additionalProperties: false });
});
