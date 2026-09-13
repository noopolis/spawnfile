import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SubjectAdapter } from '../contracts/index.js';
import type { CliDependencies, CliIO } from './types.js';

export function datasetText(records = [{ id: 'case', group: 'case-family' }]): string {
  return `schema: paideia.dataset.v1\nid: example\nchecks:\n  - id: correct\n    eval: equals\n    input: output.text\n    value: OK\nrecords:\n${records.map((record) => `  - id: ${record.id}\n    group: ${record.group}\n    input:\n      prompt: Reply OK.\n`).join('')}`;
}

export async function cliFixture() {
  const root = await mkdtemp(join(tmpdir(), 'paideia-cli-test-'));
  await writeFile(join(root, 'AGENTS.md'), 'BASE\n');
  await writeFile(join(root, 'support.md'), 'Supporting facts.\n');
  await writeFile(join(root, 'data.yaml'), datasetText());
  const stdout: string[] = [], stderr: string[] = [], observedInstructions: string[] = [];
  const io: CliIO = { cwd: root, stdout: (text) => { stdout.push(text); }, stderr: (text) => { stderr.push(text); } };
  const dependencies: CliDependencies = {
    adapter: (runtime) => fixtureAdapter(runtime, observedInstructions),
    inference: () => ({ id: 'test-subscription', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      async generate(request) {
        const payload = JSON.parse(request.prompt) as { currentComponents: Record<string, string> };
        return { text: JSON.stringify(Object.fromEntries(Object.entries(payload.currentComponents).map(([key, value]) => [key, `${value}IMPROVED\n`]))),
          model: 'deterministic-reflection-fixture', route: 'test-subscription', usage: null };
      },
    }),
  };
  const nativeArgs = ['--runtime', 'codex', '--model', 'explicit-fixture', '--instructions', 'AGENTS.md', '--out', 'out'];
  return { root, io, stdout, stderr, dependencies, observedInstructions, nativeArgs,
    bridge: resolve('bridges/dspy/.venv/bin/paideia-dspy') };
}

export function fixtureAdapter(id: string, observedInstructions: string[], mode: 'candidate' | 'pass' | 'failed' | 'stalled' = 'candidate'): SubjectAdapter {
  return { id, capabilities: { toolTrace: 'none', liveObservations: true, cancellation: 'native-handle', multiTurn: true,
    resources: ['instructions', 'supporting-files'], isolation: 'test fixture only', readIsolation: 'declared-paths', protectedPaths: true },
    async start(input) {
      observedInstructions.push(input.instructions);
      return {
        stop: async (reason) => ({ state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'Test fixture stopped.' }),
        async run(turn) {
          if (mode === 'failed') throw new Error('Synthetic native infrastructure failure');
          if (mode === 'stalled') return new Promise(() => undefined);
          const text = mode === 'pass' || input.instructions.includes('IMPROVED') ? 'OK' : 'BAD';
          await input.onObservation({ id: `${input.trialId}/${turn.id}`, source: `fixture:${input.trialId}`,
            seq: 1, type: 'output', timestamp: new Date().toISOString(), trialId: input.trialId, wakeId: turn.id, text });
          return { status: 'completed', text, usage: null,
            coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] };
        },
      };
    },
  };
}
