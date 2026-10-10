import type { ViewerData } from './types.js';

/** Public synthetic display fixture; no native observations or private text. */
export function viewerFixture(): ViewerData {
  return {
    schema: 'paideia.viewer.v1',
    experiment: { id: 'experiment', title: 'Local experiment', status: 'running', phase: 'train', updatedAt: '2026-09-13T00:00:00Z' },
    cases: [{ id: 'train', split: 'train', label: 'Training case' }, { id: 'selection', split: 'validation' }],
    trials: [{ id: 'trial-1', caseId: 'train', candidateId: 'baseline', status: 'completed', score: 0.5,
      coverage: [{ channel: 'tools', completeness: 'partial', ordering: 'source' }],
      checks: [{ id: 'gate', label: 'Required checks', status: 'fail', score: 0.5, evidenceIds: [], children: [
        { id: 'child', label: 'A known check', status: 'pass', score: 1, evidenceIds: ['event-1'], children: [] },
        { id: 'grounding', label: 'A judge that refused', status: 'error', score: null, weight: 52, weightedContribution: null,
          judgeFailure: { cause: 'provider-error', judge: 'grounding', providerId: 'grok-broker-grant',
            requestedModel: 'grok-4.6', responseModel: 'grok-4.6', responseRoute: 'grok-broker-grant',
            kind: 'quota', status: 429 }, evidenceIds: [], children: [] },
      ] }], events: [{ id: 'event-1', type: 'tool.complete', timestamp: '2026-09-13T00:00:01Z', summary: 'Declared fixture action completed.' }] }],
    candidates: [
      { id: 'baseline', parentIds: [], validationScore: 0.5, discoveryEvaluations: 0, editablePaths: ['AGENTS.md'] },
      { id: 'proposal', parentIds: ['baseline'], validationScore: 1, discoveryEvaluations: 3, editablePaths: ['AGENTS.md', 'skills/review.md'] },
    ],
    usage: [{ purpose: 'subject', model: 'observed-model', route: 'subscription', usage: {
      inputTokens: 12, cachedInputTokens: 0, outputTokens: 4, reasoningTokens: null, source: 'native',
    } }, { purpose: 'optimizer', model: null, route: null, usage: null }],
    optimizer: { name: 'dspy.GEPA', status: 'running', evaluations: 4, proposals: 1,
      maxMetricCalls: 7, maxProposals: 2, selectedCandidateId: 'proposal' },
  };
}
