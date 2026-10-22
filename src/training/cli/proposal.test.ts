import { expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from './index.js';
import type { CliDependencies } from './types.js';
import { cliFixture, datasetText } from './fixture.js';

it('passes the authored rewrite policy through the CLI into real GEPA reflection', async () => {
  const fixture = await cliFixture();
  try {
    const training = { models: { reflection: { provider: 'ollama', model: 'fixture' } },
      optimizer: { model: 'reflection', proposal: { strategy: 'rewrite', min_change: 0.5,
        max_attempts: 1, history_entries: 8, history_bytes: 8192 } },
      budget: { max_trials: 6, max_proposals: 1, timeout_ms: 15000 },
      test: 'test.yaml', validation_groups: ['b'] };
    await writeFile(join(fixture.root, 'train.yaml'), `${datasetText([{ id: 'train', group: 'a' },
      { id: 'validation', group: 'b' }])}\ntraining: ${JSON.stringify(training)}\n`);
    await writeFile(join(fixture.root, 'test.yaml'), datasetText([{ id: 'test', group: 'sealed' }]));
    let calls = 0;
    const args = ['train', '--train', 'train.yaml', ...fixture.nativeArgs,
      '--editable', 'AGENTS.md', '--bridge-command', fixture.bridge];
    const dependencies: CliDependencies = { ...fixture.dependencies,
      modelInference: () => ({ id: 'fixture', capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false },
        async generate(request) {
          calls++;
          const payload = JSON.parse(request.prompt);
          expect(JSON.stringify(request.responseSchema)).toContain('hypothesis');
          expect(JSON.stringify(request.responseSchema)).toContain('expectedImpact');
          return { text: JSON.stringify({ components: Object.fromEntries(Object.keys(payload.currentComponents)
            .map(key => [key, 'IMPROVED: Answer the requested task directly and verify the result.\n'])),
          hypothesis: 'Replace the vague baseline with an explicit output instruction.', expectedImpact: [{ criterion: 'correct', effect: 'Improve correct output.' }] }),
          model: 'fixture', route: 'fixture', usage: null };
        } }),
    };
    const code = await main(args, fixture.io, dependencies);
    expect(fixture.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(fixture.observedInstructions.some(value => value.startsWith('IMPROVED:'))).toBe(true);
    const completed = JSON.parse(await readFile(join(fixture.root, 'out/invocation.json'), 'utf8'));
    expect(completed.command).toBe('train');
    const nativeCalls = fixture.observedInstructions.length;
    expect(await main([...args, '--resume'], fixture.io, dependencies)).toBe(0);
    expect(fixture.stderr).toEqual([]);
    const resumed = JSON.parse(await readFile(join(fixture.root, 'out/invocation.json'), 'utf8'));
    expect(resumed.trialIds).toEqual(completed.trialIds);
    expect(resumed.candidateId).toBe(completed.candidateId);
    expect(calls).toBe(1);
    expect(fixture.observedInstructions).toHaveLength(nativeCalls);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
