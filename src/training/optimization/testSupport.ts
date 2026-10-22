import path from 'node:path';
import type { DspyOptimizationOptions } from './types.js';
import type { DspyEvaluateParams, DspyGenerateParams } from './protocol.js';

/** Offline integration fixture; the tested optimizer is the installed DSPy release. */
export function simulatedOptions(): {
  options: DspyOptimizationOptions; evaluations: DspyEvaluateParams[]; generations: DspyGenerateParams[];
} {
  const evaluations: DspyEvaluateParams[] = [], generations: DspyGenerateParams[] = [];
  const options: DspyOptimizationOptions = {
    id: 'typescript-gepa', components: { 'AGENTS.md': '\n  Keep identity.\n\n', 'skills/report/SKILL.md': '# Report\n' },
    trainCaseIds: ['train'], validationCaseIds: ['validation-secret'],
    budget: { maxMetricCalls: 10, maxProposals: 2 }, seed: 7,
    bridge: { command: path.resolve('bridges/dspy/.venv/bin/paideia-dspy'), cwd: process.cwd(), timeoutMs: 10_000 },
    validateComponents: () => undefined,
    evaluate: async (request) => {
      evaluations.push(request);
      const score = Math.min(...Object.values(request.components).map((text) => text.split('Revision ').length - 1)) / 2;
      return { score, feedback: request.split === 'train' ? 'Revise both text resources.' : '',
        output: request.split === 'train' ? 'actual-host-output' : '', captureId: `capture-${evaluations.length}` };
    },
    generate: async (request) => {
      generations.push(request);
      const payload = JSON.parse(request.messages[1]!.content) as { currentComponents: Record<string, string>; updateOnly: string[] };
      return { text: JSON.stringify(Object.fromEntries(payload.updateOnly.map((key) =>
        [key, `${payload.currentComponents[key]}Revision ${generations.length}.\n`]))),
      model: 'simulated-subscription', usage: null, route: 'simulated-subscription' };
    },
  };
  return { options, evaluations, generations };
}

export function scriptBridge(code: string): DspyOptimizationOptions['bridge'] {
  return { command: process.execPath, args: ['-e', code], cwd: process.cwd(), timeoutMs: 2_000, closureDrainMs: 50 };
}
