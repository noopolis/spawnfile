import { afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubjectAdapter, SubjectStart, SubjectTurnResult } from '../../contracts/execution.js';
import type { TrialEvent, TrialOptions } from './types.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
export const capabilities: SubjectAdapter['capabilities'] = { toolTrace: 'complete', liveObservations: true, cancellation: 'native-handle',
  multiTurn: true, resources: ['instructions'], readIsolation: 'declared-paths', protectedPaths: true, isolation: 'deterministic test facade' };
export const complete: SubjectTurnResult = { status: 'completed', text: 'DONE', usage: null,
  coverage: [{ channel: 'tools', completeness: 'complete', ordering: 'source' }, { channel: 'output', completeness: 'complete', ordering: 'source' }] };
export async function setup(run?: (input: SubjectStart, turn: { id: string; text: string }) => Promise<SubjectTurnResult>) {
  const root = await mkdtemp(join(tmpdir(), 'paideia-trial-')); roots.push(root);
  const journal: TrialEvent[] = []; let stops = 0; let starts = 0;
  const adapter: SubjectAdapter = { id: 'fixture', capabilities,
    async start(input) { starts++; return {
      async run(turn) { return run ? run(input, turn) : complete; },
      async stop(reason) { stops++; return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'fixture ended' }; },
    }; } };
  const record = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: suite
checks:
  - {id: done, eval: equals, input: output.text, value: DONE}
records:
  - {id: record, group: unique, input: {prompt: do it}}
`)).records[0]!;
  const options: TrialOptions = { id: 'trial', phase: 'train', record, candidateId: 'candidate', datasetDigest: 'dataset', planDigest: 'plan',
    adapter, model: 'explicit', root, timeoutMs: 5_000, prepare: async () => ({ instructions: 'original instructions' }),
    registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => { throw new Error('unregistered sidecar'); } },
    persist: async event => { journal.push(structuredClone(event)); } };
  return { options, journal, get stops() { return stops; }, get starts() { return starts; } };
}
