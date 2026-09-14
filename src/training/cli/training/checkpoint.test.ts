import { createHash } from 'node:crypto';
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
  const flags = Object.fromEntries(Object.entries(args.flags).filter(([name]) =>
    !['resume', 'view', 'out', 'spawnfile-context', 'dry-run'].includes(name)).sort(([a], [b]) => a.localeCompare(b)));
  const legacyIdentity = createHash('sha256').update(JSON.stringify({
    version: 'paideia.command-execution.v1', flags, training: args.training, candidate: inputs.candidate.id,
    sourceRoot: inputs.sourceRoot, resources: inputs.resources, model: inputs.model, context: null, integration: null,
  })).digest('hex');
  await writeFile(join(first.directory, 'command.json'), JSON.stringify({
    schema: first.schema, id: first.id, identity: legacyIdentity,
  }));
  await expect(commandCheckpoint(resume, inputs, fixture.dependencies)).rejects.toThrow('inputs changed');
  await writeFile(join(first.directory, 'command.json'), '{}');
  await expect(commandCheckpoint(resume, inputs, fixture.dependencies)).rejects.toThrow();
});

it('rejects ambient-to-container and changed-image resume before inference with unchanged authored inputs', async () => {
  const fixture = await cliFixture(); roots.push(fixture.root);
  const args = parseArguments(['train', ...fixture.nativeArgs, '--train', 'data.yaml']);
  const inputs = await prepareCliInputs(args, fixture.io, fixture.dependencies);
  const integration = { id: 'execution', version: '1', createAdapter: () => { throw new Error('No cognition'); },
    prepareEnvironment: async () => { throw new Error('No preparation'); } };
  const dependencies = { ...fixture.dependencies, spawnfile: integration };
  const first = await commandCheckpoint(args, inputs, dependencies);
  const resume = { ...args, flags: { ...args.flags, resume: ['true'] } };
  expect((await commandCheckpoint(resume, inputs, dependencies)).identity).toBe(first.identity);
  const scoped = { ...dependencies, spawnfile: { ...integration, inferenceExecutionIdentity: 'image:one' } };
  await expect(commandCheckpoint(resume, inputs, scoped)).rejects.toThrow('inputs changed');
  const secondInputs = { ...inputs, out: join(fixture.root, 'container') };
  await commandCheckpoint(args, secondInputs, scoped);
  await expect(commandCheckpoint(resume, secondInputs, { ...scoped,
    spawnfile: { ...integration, inferenceExecutionIdentity: 'image:two' } })).rejects.toThrow('inputs changed');
});
