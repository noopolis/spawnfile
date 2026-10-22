import type { EvaluationContext, EvaluationSnapshot, ArtifactSnapshot } from '../contracts/evaluation.js';
import type { Observation } from '../contracts/execution.js';

export function observation(overrides: Partial<Observation> = {}): Observation {
  return { id: 'dispatch', source: 'native', seq: 1, type: 'tool.dispatch',
    timestamp: '2026-09-13T12:00:00Z', trialId: 'trial', wakeId: 'wake',
    callId: 'call', tool: 'validate', args: { value: 'article' }, ...overrides };
}
export function artifact(value: unknown = { body: ['A precise report.'] }): ArtifactSnapshot {
  return { name: 'article', checkpointId: 'checkpoint-1', digest: 'sha256:example',
    bytes: JSON.stringify(value), value, provenance: 'test fixture', acceptedCallId: 'file' };
}
export function snapshot(overrides: Partial<EvaluationSnapshot> = {}): EvaluationSnapshot {
  return { trialId: 'trial', recordId: 'record', closed: true, events: [],
    coverage: [{ channel: 'tools', completeness: 'complete', ordering: 'source' },
      { channel: 'output', completeness: 'complete', ordering: 'source' }],
    artifacts: { article: artifact() }, output: '4', inputFiles: { packet: 'Source evidence' },
    context: { edition: '2026-09-13' }, ...overrides };
}
export function evaluationContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return { snapshot: snapshot(), results: {}, scores: {}, judges: {}, embeddings: {},
    readText: async () => { throw new Error('Sidecar not registered'); }, ...overrides };
}
