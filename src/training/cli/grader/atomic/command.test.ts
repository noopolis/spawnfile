import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseArguments } from '../../arguments.js';
import { runGraderCommand } from '../index.js';
import { fixture } from './fixtures.js';

it('routes atomic commands without a grader argument and returns gate exit codes', async () => {
  const f = await fixture(); const lines: string[] = [];
  const io = { cwd: f.root, stdout: (text: string) => lines.push(text), stderr: () => undefined };
  const run = (args: string[]) => runGraderCommand(parseArguments(['grader', ...args]), io, f.dependencies);
  expect(await run(['decompose', '--templates', 'templates.yaml', '--inputs', 'inputs.yaml', '--extractors', 'codex,claude', '--out', 'decompositions'])).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ completed: 1 });
  f.generate.mockImplementation(async request => {
    const prompt = JSON.parse(request.prompt);
    const text: string = (prompt.projection ?? prompt.questions[0].evidence).unit.text;
    return { text: JSON.stringify({ 'support@claim': { answer: text.includes('12') ? 'supported' : 'unsupported' } }),
      model: request.model, usage: null, route: 'subscription' };
  });
  expect(await run(['reference', '--templates', 'templates.yaml', '--decompositions', 'decompositions', '--teachers', 'codex,claude', '--out', 'base.json'])).toBe(1);
  expect(await run(['traps', '--templates', 'templates.yaml', '--decompositions', 'decompositions', '--references', 'base.json', '--out', 'traps'])).toBe(0);
  expect(await run(['reference', '--templates', 'templates.yaml', '--decompositions', 'decompositions', '--traps', 'traps',
    '--teachers', 'codex,claude', '--out', 'references.json', '--concurrency', '1', '--timeout-ms', '5000'])).toBe(0);
  expect(await run(['reference', '--templates', 'templates.yaml', '--decompositions', 'decompositions',
    '--teachers', 'codex,claude', '--out', 'references-without-traps.json'])).toBe(1);
});

it('returns nonzero for rejected extraction spans and a zero-trap corpus', async () => {
  const f = await fixture(); const lines: string[] = [];
  f.unit.text = 'Invented';
  const io = { cwd: f.root, stdout: (text: string) => lines.push(text), stderr: () => undefined };
  expect(await runGraderCommand(parseArguments(['grader', 'decompose', '--templates', 'templates.yaml', '--inputs', 'inputs.yaml',
    '--extractors', 'codex', '--out', 'decompositions']), io, f.dependencies)).toBe(1);
  expect(await runGraderCommand(parseArguments(['grader', 'traps', '--templates', 'templates.yaml', '--decompositions', 'decompositions',
    '--allow-rejections', '--out', 'traps', '--seed', '42']), io, f.dependencies)).toBe(1);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ generated: 0 });
});

it('rejects missing/repeated atomic flags and propagates command cancellation', async () => {
  for (const args of [
    ['decompose', '--templates', 't', '--inputs', 'i', '--out', 'o'],
    ['traps', '--templates', 't', '--out', 'o'],
    ['reference', '--templates', 't', '--decompositions', 'd', '--out', 'o'],
    ['traps', '--templates', 't', '--decompositions', 'd', '--out', 'o', '--out', 'again'],
    ['reference', '--templates', 't', '--decompositions', 'd', '--teachers', 'codex,claude', '--out', 'o', '--grader', 'g'],
  ]) expect(() => parseArguments(['grader', ...args])).toThrow();
  const f = await fixture();
  await writeFile(f.templatesFile, 'invalid');
  await expect(runGraderCommand(parseArguments(['grader', 'decompose', '--templates', 'templates.yaml', '--inputs', 'inputs.yaml',
    '--extractors', 'codex', '--out', 'decompositions']), { cwd: f.root, stdout: () => undefined, stderr: () => undefined }, f.dependencies,
  AbortSignal.abort())).rejects.toThrow();
});
