import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { OptimizationCheckpoint } from './checkpoint.js';
import { DSPY_SCHEMA, startSchema, type DspyRequest } from './protocol.js';

it('reserves cumulatively and publishes concurrent completions without losing any journal entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parallel-journal-'));
  try {
    const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: 'run', components: { prompt: 'one' },
      trainCaseIds: ['train'], validationCaseIds: ['validation'], budget: { maxMetricCalls: 4, maxProposals: 1 } });
    const config = { directory, identity: 'environment', resume: false };
    const journal = await OptimizationCheckpoint.open(start, config);
    const request = (index: number): DspyRequest => ({ schema: DSPY_SCHEMA, kind: 'request', method: 'evaluate', id: `id-${index}`,
      params: { caseId: 'train', split: 'train', components: start.components } });
    const entries = await Promise.all(Array.from({ length: 4 }, (_, index) => journal.begin(request(index), start.budget)));
    await expect(journal.begin(request(4), start.budget)).rejects.toThrow('budget exhausted');
    await Promise.all([...entries].reverse().map((entry, index) => journal.complete(entry,
      { score: 1, feedback: '', output: '', captureId: `capture-${index}` })));
    const saved = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'));
    expect(saved.entries).toHaveLength(4);
    const restored = await OptimizationCheckpoint.open(start, { ...config, resume: true });
    expect(restored.entries).toEqual(journal.entries);
    expect(restored.entries.every(entry => entry.result !== undefined)).toBe(true);
    for (let index = 0; index < 4; index++) expect((await restored.begin(request(index), start.budget)).attempts).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
