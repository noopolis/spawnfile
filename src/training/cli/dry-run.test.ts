import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from './commands.js';
import { cliFixture, datasetText } from './fixture.js';
import { readCostConfig } from './dry-run.js';
import { parseArguments } from './arguments.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'train.yaml'), datasetText([{ id: 'a', group: 'a' }, { id: 'b', group: 'b' }]));
  await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'x', group: 'x' }]).replace('id: example', 'id: sealed'));
  const args = ['train', '--train', 'train.yaml', '--test', 'test.yaml', '--runtime', 'codex', '--model', 'gpt-5.5',
    '--instructions', 'AGENTS.md', '--editable', 'AGENTS.md', '--optimizer-model', 'claude-fable-5-1', '--dry-run'];
  return { ...f, args };
}

describe('training dry-run command', () => {
  it('makes zero adapter/inference calls and no trial, optimizer or output directory', async () => {
    const f = await fixture();
    const before = await readdir(f.root);
    const adapter = vi.fn(() => { throw new Error('Native factory was invoked'); });
    const inference = vi.fn(() => { throw new Error('Inference factory was invoked'); });
    expect(await main(f.args, f.io, { adapter, inference })).toBe(0);
    expect(adapter).not.toHaveBeenCalled(); expect(inference).not.toHaveBeenCalled();
    expect(f.stderr).toEqual([]);
    const plan = JSON.parse(f.stdout.join(''));
    expect(plan).toMatchObject({ schema: 'paideia.training-cost-plan.v1', modelCallsMade: 0, coverage: 'estimated' });
    expect(plan.candidateId).toBeTruthy();
    expect(plan.apiEquivalentUsd.high).toBeGreaterThan(0);
    expect(await readdir(f.root)).toEqual(before);
    await expect(access(join(f.root, 'out'))).rejects.toThrow();
  });
  it('uses local price/assumption configuration and rejects missing/invalid inputs', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'cost.yaml'), 'schema: paideia.cost-config.v1\nassumptions:\n  subject:\n    inputTokens: {low: 1000, high: 2000}\n    outputTokens: {low: 100, high: 200}\n    cacheReadFraction: {low: 0, high: 0}\n');
    expect(await main([...f.args, '--cost-config', 'cost.yaml'], f.io)).toBe(0);
    expect(JSON.parse(f.stdout[0]!).assumptions.subject.inputTokens.high).toBe(2000);
    expect(await main([...f.args, '--cost-config', 'absent.yaml'], f.io)).toBe(2);
    await writeFile(join(f.root, 'cost.yaml'), 'schema: a\nschema: b\n');
    expect(() => readCostConfig(parseArguments([...f.args, '--cost-config', 'cost.yaml']), f.io)).toThrow('Invalid cost configuration');
    expect(await main(f.args.filter((_, index) => ![12, 13].includes(index)), f.io)).toBe(2);
  });
  it('prices independently selected named judges without opening inference', async () => {
    const f = await fixture();
    const checks = ['prose', 'grounding'].map(judge => ({ id: judge, eval: 'llm-rubric', judge,
      input: 'output.text', minimum: 0.8, rubric: { prompt: 'Check the declared output.' } }));
    for (const [name, groups] of [['train', ['a', 'b']], ['test', ['x']]] as const) {
      await writeFile(join(f.root, `${name}.yaml`), JSON.stringify({ schema: 'paideia.dataset.v1', id: name, checks,
        records: groups.map(group => ({ id: group, group, input: { prompt: 'Reply OK.' } })) }));
    }
    const inference = vi.fn(() => { throw new Error('No judge construction'); });
    expect(await main([...f.args, '--judge', 'prose=claude-fable-5-1', '--judge', 'grounding=unpriced-judge-model'], f.io, { inference })).toBe(0);
    const plan = JSON.parse(f.stdout.join(''));
    expect(plan.coverage).toBe('partial'); expect(plan.apiEquivalentUsd).toBeNull();
    expect(plan.lines.filter((line: { role: string }) => line.role === 'judge').map((line: { name: string; model: string }) => [line.name, line.model]))
      .toEqual([['prose', 'claude-fable-5-1'], ['prose', 'claude-fable-5-1'], ['grounding', 'unpriced-judge-model'], ['grounding', 'unpriced-judge-model']]);
    expect(inference).not.toHaveBeenCalled();
  });
  it('parses dry-run as a standalone boolean only on training', () => {
    expect(parseArguments(['train', '--dry-run']).flags['dry-run']).toEqual(['true']);
    expect(() => parseArguments(['train', '--dry-run', '--dry-run'])).toThrow('only once');
    expect(() => parseArguments(['train', '--dry-run', 'false'])).toThrow();
    expect(() => parseArguments(['evaluate', 'data.yaml', '--dry-run'])).toThrow('Unsupported');
  });
});
