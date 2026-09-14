import { afterEach, expect, it } from 'vitest';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliFixture } from '../fixture.js';
import { parseArguments } from '../arguments.js';
import { prepareCliInputs } from '../native.js';
import { commandCheckpoint } from './checkpoint.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('resumes one identity while ignoring presentation flags and rejects execution changes', async () => {
  const fixture = await cliFixture(); roots.push(fixture.root);
  const args = parseArguments(['train', ...fixture.nativeArgs, '--train', 'data.yaml']);
  const inputs = await prepareCliInputs(args, fixture.io, fixture.dependencies);
  const first = await commandCheckpoint(args, inputs, fixture.dependencies);
  expect(first.resume).toBe(false);
  expect((await stat(join(first.directory, 'command.json'))).mode & 0o777).toBe(0o600);
  await expect(commandCheckpoint(args, inputs, fixture.dependencies)).rejects.toMatchObject({ code: 'EEXIST' });
  const resume = { ...args, flags: { ...args.flags, resume: ['true'], view: ['12500'] } };
  expect(await commandCheckpoint(resume, inputs, fixture.dependencies)).toEqual({ ...first, resume: true });
  await expect(commandCheckpoint({ ...resume, flags: { ...resume.flags, seed: ['7'] } }, inputs,
    fixture.dependencies)).rejects.toThrow('inputs changed');
  await writeFile(join(first.directory, 'command.json'), '{}');
  await expect(commandCheckpoint(resume, inputs, fixture.dependencies)).rejects.toThrow();
});
