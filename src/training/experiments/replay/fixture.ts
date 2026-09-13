import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry, result } from '../../evaluation/index.js';
import { openExperimentStore } from '../../storage/index.js';
import type { TrialReport } from '../trials/index.js';
import type { RescoreOptions } from './types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

export function criteria() {
  return resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: revised-criteria
checks: [{id: article, eval: contains-any, input: output.text, values: [ARTICLE]}]
records: [{id: story, input: {prompt: This new stimulus must not run}, context: {origin: new}}]
`));
}

export async function fixture(change?: (report: TrialReport) => void) {
  const root = await mkdtemp(join(tmpdir(), 'paideia-rescore-')); roots.push(root);
  const store = await openExperimentStore(root);
  const coverage: TrialReport['snapshot']['coverage'] = [
    { channel: 'output', completeness: 'complete', ordering: 'source' },
    { channel: 'tools', completeness: 'partial', ordering: 'source' },
  ];
  const bytes = '{"headline":"ARTICLE"}';
  const report: TrialReport = { schema: 'paideia.trial.v1', id: 'trial', phase: 'train', candidateId: 'candidate',
    datasetDigest: 'original-dataset-digest', planDigest: 'original-plan', recordId: 'story',
    paths: { root: '/absent', workspace: '/absent/workspace', control: '/absent/control', runtimeHome: '/absent/runtime' },
    status: 'fail', execution: 'completed', hostWork: 'settled',
    snapshot: { trialId: 'trial', recordId: 'story', closed: true, events: [], coverage,
      output: 'ARTICLE', inputFiles: { packet: 'Original evidence' }, context: { origin: 'original' },
      artifacts: { article: { name: 'article', checkpointId: 'final/article', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes, value: JSON.parse(bytes), provenance: 'workspace:article.json' } } },
    turns: [{ id: 'task', native: { status: 'completed', text: 'ARTICLE', coverage: [...coverage],
      usage: { inputTokens: 10, cachedInputTokens: null, outputTokens: 2, reasoningTokens: null, source: 'fixture' } }, checks: [] }],
    evaluation: { status: 'fail', checks: { old: result('fail', 'Old rubric') }, scores: {},
      stages: [{ id: 'old', checks: [], gate: result('fail', 'Old rubric') }] }, live: [],
  };
  change?.(report);
  await store.createRun({ schema: 'paideia.run.v1', id: 'trial', datasetId: 'original-dataset', datasetRole: report.phase,
    candidateId: 'candidate', planDigest: 'original-plan', recordId: 'story' });
  await store.appendEvent('trial', { id: 'closed', payload: { type: 'trial.completed', payload: report } });
  await store.appendEvaluation('trial', { id: 'original', report });
  const runRoot = join(root, 'runs', (await readdir(join(root, 'runs')))[0]!);
  const originalPath = join(runRoot, 'evaluations', (await readdir(join(runRoot, 'evaluations')))[0]!);
  const options: RescoreOptions = { store, runId: 'trial', access: { audience: 'evaluator', phase: 'replay' },
    id: 'rescore', dataset: criteria(), registry: createEvaluationRegistry(),
    evaluation: { judges: {}, embeddings: {}, readText: async () => { throw new Error('Unexpected sidecar read'); } } };
  return { options, store, report, runRoot, originalPath };
}
