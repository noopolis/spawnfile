import { expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../index.js';
import { cliFixture } from '../fixture.js';
import type { CliDependencies } from '../types.js';
import { openExperimentStore } from '../../storage/index.js';

it('runs authored evidence-ID judges through CLI training, real GEPA and frozen evaluation', async () => {
  const f = await cliFixture();
  try {
    const dataset = { schema: 'paideia.dataset.v1', id: 'protocol',
      stages: [{ id: 'writing', checks: [{ id: 'clarity', eval: 'llm-rubric', input: 'output.text',
        judge: 'editor', minimum: 0.8, rubric: { prompt: 'Reply OK.' } }],
      score: { linear: { clarity: 1 } }, gate: { passed: 'clarity' } }] };
    const record = (id: string, group: string) => ({ id, group, input: { prompt: 'Reply OK.' } });
    await writeFile(join(f.root, 'train.yaml'), JSON.stringify({ ...dataset,
      records: [record('train', 'train'), record('validation', 'validation')], training: {
        models: { judge: { provider: 'ollama', model: 'judge' }, reflection: { provider: 'ollama', model: 'reflection' } },
        judges: { editor: { model: 'judge', protocol: 'evidence-ids' } },
        optimizer: { model: 'reflection' }, test: 'test.yaml', validation_groups: ['validation'],
        budget: { max_trials: 6, max_proposals: 1, timeout_ms: 15000 },
      } }));
    await writeFile(join(f.root, 'test.yaml'), JSON.stringify({ ...dataset, id: 'sealed', records: [record('test', 'sealed')] }));
    let judgments = 0, proposals = 0;
    const dependencies: CliDependencies = { ...f.dependencies, modelInference: selected => ({
      id: selected.model, capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false },
      async generate(request) {
        let text: string;
        if (selected.model === 'reflection') {
          proposals++;
          const payload = JSON.parse(request.prompt) as { currentComponents: Record<string, string> };
          text = JSON.stringify(Object.fromEntries(Object.keys(payload.currentComponents).map(key => [key, 'IMPROVED\n'])));
        } else {
          judgments++;
          expect(request.responseSchema).toMatchObject({ required: ['score', 'verdict', 'reasons', 'evidenceIds'] });
          const packet = JSON.parse(request.prompt.split('SOURCE DATA\n')[1]!) as { units: { id: string; value: string }[] };
          expect(packet.units).toHaveLength(1);
          const good = packet.units[0]!.value === 'OK';
          text = JSON.stringify({ score: good ? 1 : 0, verdict: good ? 'pass' : 'fail',
            reasons: ['Measured the observed output.'], evidenceIds: [packet.units[0]!.id] });
        }
        return { text, model: selected.model, route: selected.model, usage: null };
      },
    }) };
    const code = await main(['train', '--train', 'train.yaml', ...f.nativeArgs,
      '--editable', 'AGENTS.md', '--bridge-command', f.bridge], f.io, dependencies);
    expect(f.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(proposals).toBe(1);
    expect(judgments).toBeGreaterThanOrEqual(4);
    const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
    const store = await openExperimentStore(join(f.root, 'out'));
    const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test',
      frozenCandidateIds: [index.candidateId] })).toString());
    expect(index.command).toBe('train');
    expect(index.outcome).not.toBe('failed');
    expect(JSON.stringify(report)).not.toContain('invalid-response');
    expect(f.observedInstructions).toContain('IMPROVED\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
