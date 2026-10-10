import { expect, it } from 'vitest';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { main } from './index.js';
import { fixtureAdapter } from './fixture.js';
import { contextFixture } from './spawnfile/fixture.js';
import type { CliDependencies } from './types.js';
import { InferenceFailure } from '../inference/index.js';
import { openExperimentStore } from '../storage/index.js';
import { repairDigest, type MeasurementRepairReceipt } from '../experiments/repair/index.js';

const oldImage = `sha256:${'a'.repeat(64)}`, newImage = `sha256:${'b'.repeat(64)}`;
async function project() {
  const f = await contextFixture();
  const stdout: string[] = [], stderr: string[] = [], native: string[] = [];
  const io = { cwd: f.root, stdout(text: string) { stdout.push(text); }, stderr(text: string) { stderr.push(text); } };
  const check = (id: string) => ({ id, eval: 'llm-rubric', input: 'output.text', judge: id, minimum: 0.8, rubric: { prompt: `Measure ${id}.` } });
  const dataset = { schema: 'paideia.dataset.v1', id: 'development', stages: [{ id: 'writing',
    checks: [check('grounding'), check('prose')], score: { linear: { grounding: 2, prose: 1 } },
    gate: { all: [{ passed: 'grounding' }, { passed: 'prose' }] } }] };
  const record = (id: string) => ({ id, group: id, input: { prompt: 'Write using evidence.' } });
  await writeFile(join(f.root, 'train.yaml'), JSON.stringify({ ...dataset, records: [record('train'), record('validation')], training: {
    models: { grounding: { provider: 'ollama', model: 'grounding' }, prose: { provider: 'ollama', model: 'prose' }, reflection: { provider: 'ollama', model: 'reflection' } },
    judges: { grounding: { model: 'grounding', protocol: 'evidence-ids' }, prose: { model: 'prose', protocol: 'evidence-ids' } },
    cache: { mode: 'off' }, optimizer: { model: 'reflection' }, test: 'test.yaml', validation_groups: ['validation'],
    budget: { max_trials: 10, max_proposals: 1, timeout_ms: 15000 }, recovery: { max_attempts: 2 },
  } }));
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify({ ...dataset, id: 'heldout', records: [record('test')] }));
  const calls = { grounding: 0, prose: 0, reflection: 0 };
  let failure = true, image = oldImage;
  const dependencies: CliDependencies = {
    spawnfile: { id: 'fixed-integration', version: '1', get inferenceExecutionIdentity() { return image; },
      executionIdentity: () => image, prepareEnvironment: async () => ({}),
      createAdapter() {
        const adapter = fixtureAdapter('daimon-native', native);
        return { ...adapter, capabilities: { ...adapter.capabilities, resources: [...adapter.capabilities.resources, 'native-skills'] },
          async start(input) {
            const handle = await adapter.start(input);
            return { ...handle, async run(turn) {
              const returned = await handle.run(turn);
              return { ...returned, usage: { inputTokens: 100, outputTokens: 10,
                cachedInputTokens: 50, reasoningTokens: null, source: 'native-fixture' },
              coverage: [...returned.coverage, { channel: 'usage' as const, completeness: 'complete' as const, ordering: 'source' as const }] };
            } };
          } };
      } },
    modelInference(selected) { return { id: selected.model,
      capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false },
      async generate(request) {
        const model = selected.model as keyof typeof calls; calls[model]++;
        if (model === 'reflection') {
          const payload = JSON.parse(request.prompt);
          return { model, route: 'fixture', modelBasis: 'provider-reported' as const,
            usage: { inputTokens: 8030, cachedInputTokens: 128, outputTokens: 843, cacheWriteInputTokens: 0, reasoningTokens: null, source: 'optimizer-fixture' },
            text: JSON.stringify(Object.fromEntries(Object.keys(payload.currentComponents).map(key => [key, 'IMPROVED\n']))) };
        }
        if (model === 'grounding' && failure && native.length === 3) throw new InferenceFailure('protocol', 'Original invalid judgment');
        const packet = JSON.parse(request.prompt.split('SOURCE DATA\n')[1]!);
        const good = packet.units[0].value === 'OK';
        const score = model === 'prose' ? 0.88 : good ? 0.95 : 0.5;
        return { model, route: 'fixture', usage: { inputTokens: 8, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: null, source: 'judge-fixture' },
          text: JSON.stringify({ score, verdict: score >= 0.8 ? 'pass' : 'fail', reasons: ['Measured output.'], evidenceIds: [packet.units[0].id] }) };
      } }; },
  };
  const args = ['train', '--train', 'train.yaml', '--spawnfile-context', f.path, '--editable', 'AGENTS.md',
    '--bridge-command', resolve('bridges/dspy/.venv/bin/paideia-dspy')];
  return { ...f, args, dependencies, io, stdout, stderr, calls, native, recover() { failure = false; image = newImage; } };
}

async function projection(f: Awaited<ReturnType<typeof project>>) {
  const parent = join(f.root, 'parent'), copied = join(f.root, 'readonly-parent');
  await mkdir(join(copied, 'checkpoint'), { recursive: true });
  for (const name of ['runs', 'blobs']) await cp(join(parent, name), join(copied, name), { recursive: true });
  const checkpoints = {} as MeasurementRepairReceipt['parent']['checkpoints'];
  for (const name of ['command', 'training', 'host', 'optimizer'] as const) {
    const bytes = await readFile(join(parent, 'checkpoint', `${name}.json`));
    checkpoints[name] = repairDigest(bytes); await writeFile(join(copied, 'checkpoint', `${name}.json`), bytes);
  }
  const files: { path: string; size: number; sha256: string }[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { const bytes = await readFile(path); files.push({ path: relative(copied, path), size: bytes.length, sha256: repairDigest(bytes) }); }
    }
  };
  await walk(copied);
  const manifest = JSON.stringify({ version: 'paideia.repair-parent.v1', files });
  await writeFile(join(copied, 'projection-manifest.json'), manifest);
  const command = JSON.parse(await readFile(join(copied, 'checkpoint/command.json'), 'utf8'));
  const training = JSON.parse(await readFile(join(copied, 'checkpoint/training.json'), 'utf8'));
  const receipt: MeasurementRepairReceipt = { version: 'paideia.measurement-repair.v1',
    parent: { root: copied, imageId: oldImage, experimentId: command.id, executionIdentity: command.identity,
      manifestDigest: repairDigest(manifest), checkpoints, trainingIdentity: training.state.identity },
    current: { imageId: newImage, canonicalSourceDigest: f.context.project.sourceDigest, adapterId: 'daimon-native' },
    compatibility: { version: 'spawnfile.daimon-dspy-compatibility.v1', digest: oldImage,
      components: { fixture: oldImage }, inputs: { canonical: f.context.project.sourceDigest } } };
  receipt.compatibility.digest = repairDigest(JSON.stringify({ components: receipt.compatibility.components, inputs: receipt.compatibility.inputs }));
  const envelope = { receipt, digest: repairDigest(JSON.stringify(receipt)) }, path = join(f.root, 'repair.json');
  await writeFile(path, JSON.stringify(envelope));
  return { parent, copied, path, envelope, training };
}

it('forks actual CLI/GEPA pending measurement without repeating prior native work, proposals or valid grades', async () => {
  const f = await project();
  try {
    for (const flag of ['--repair-context', '--repair-measurements']) {
      expect(await main([...f.args, '--out', 'invalid', flag, 'missing'], f.io, f.dependencies)).toBe(2);
      expect(f.stderr.at(-1)).toContain('requires both');
      expect(f.native).toEqual([]); expect(f.calls).toEqual({ grounding: 0, prose: 0, reflection: 0 });
    }
    f.stderr.length = 0;
    expect(await main([...f.args, '--out', 'parent'], f.io, f.dependencies)).toBe(2);
    expect(f.stderr.join()).toContain('unscorable');
    // A protocol failure is terminal; no unverified generation retry is billed.
    expect(f.native).toHaveLength(3); expect(f.calls).toEqual({ grounding: 3, prose: 3, reflection: 1 });
    const p = await projection(f), before = JSON.stringify(p.training);
    const { capturedTrial } = await import('../experiments/replay/index.js');
    const checkStore = await openExperimentStore(p.parent);
    for (const entry of Object.values(p.training.state.entries) as { id: string; report: unknown }[]) {
      expect(capturedTrial(await checkStore.readReplay(entry.id, { audience: 'operator', phase: 'replay' })).report).toStrictEqual(entry.report);
    }
    f.recover(); f.stderr.length = 0;
    const args = [...f.args, '--out', 'child', '--repair-measurements', p.copied, '--repair-context', p.path];
    const originalReceipt = await readFile(p.path);
    const callsBefore = { ...f.calls }, nativeBefore = f.native.length;
    const changed = structuredClone(p.envelope); changed.receipt.current.imageId = oldImage;
    changed.digest = repairDigest(JSON.stringify(changed.receipt));
    await writeFile(p.path, JSON.stringify(changed));
    expect(await main([...args.slice(0, -4), '--repair-measurements', p.copied, '--repair-context', p.path], f.io, f.dependencies)).toBe(2);
    expect(f.stderr.at(-1)).toContain('compatibility authority');
    await writeFile(p.path, originalReceipt); f.stderr.length = 0;
    const exactResume = [...f.args, '--out', 'parent', '--resume'];
    expect(await main(exactResume, f.io, f.dependencies)).toBe(2);
    expect(f.stderr.at(-1)).toContain('inputs changed'); f.stderr.length = 0;
    expect(f.calls).toEqual(callsBefore); expect(f.native).toHaveLength(nativeBefore);
    expect(await main(args, f.io, f.dependencies), f.stderr.join()).toBe(0);
    expect(f.stderr).toEqual([]);
    expect(f.native).toHaveLength(6);
    // The explicit measurement repair adds calls without retrying protocol failures.
    expect(f.calls).toEqual({ grounding: 7, prose: 6, reflection: 1 });
    const index = JSON.parse(await readFile(join(f.root, 'child/invocation.json'), 'utf8'));
    const store = await openExperimentStore(join(f.root, 'child'));
    const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString());
    expect(report.trials).toHaveLength(6);
    const optimizerCheckpoint = JSON.parse(await readFile(join(f.root, 'child/checkpoint/optimizer.json'), 'utf8'));
    expect(optimizerCheckpoint.payload.lineage.parent).toEqual({
      directory: join(p.copied, 'checkpoint'), identity: p.envelope.receipt.parent.executionIdentity,
      id: p.envelope.receipt.parent.experimentId, digest: p.envelope.receipt.parent.checkpoints.optimizer,
    });
    expect(report.lineage).toMatchObject({ kind: 'measurement-repair', parentExperimentId: p.envelope.receipt.parent.experimentId,
      parentExecutionIdentity: p.envelope.receipt.parent.executionIdentity, receiptDigest: p.envelope.digest });
    expect(report.lineage.inheritedTrialIds).toHaveLength(3);
    expect(report.experimentId).not.toBe(p.envelope.receipt.parent.experimentId);
    expect(report.rescores).toHaveLength(1);
    const rescore = report.rescores[0], original = report.trials.find((trial: { id: string }) => trial.id === rescore.runId);
    expect(rescore.evaluation.checks.prose).toEqual(original.evaluation.checks.prose);
    expect(rescore.evaluation.checks.prose.score).toBe(0.88);
    expect(rescore.repair.errorPaths).toEqual(['/stages/0/checks/0']);
    expect(report.costs.entries.filter((entry: { role: string }) => entry.role === 'subject')).toHaveLength(6);
    const nativeTokens = report.costs.entries.filter((entry: { role: string }) => entry.role === 'subject')
      .reduce((sum: number, entry: { usage: { inputTokens: number; outputTokens: number } }) => sum + entry.usage.inputTokens + entry.usage.outputTokens, 0);
    expect(nativeTokens).toBe(660);
    expect(JSON.stringify(JSON.parse(await readFile(join(p.parent, 'checkpoint/training.json'), 'utf8')))).toBe(before);
    const measured = { ...f.calls }, count = f.native.length;
    expect(await main([...args, '--resume'], f.io, f.dependencies), f.stderr.join()).toBe(0);
    expect(f.calls).toEqual(measured); expect(f.native).toHaveLength(count);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 15000);
