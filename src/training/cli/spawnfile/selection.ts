import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { snapshotCandidate, type ResourceMapping } from '../../candidates/index.js';
import { count, judgeCitationRepairs, one, pairs, type CliArguments } from '../arguments.js';
import { CliDatasets } from '../datasets.js';
import type { CliIO, SpawnfileCliIntegration } from '../types.js';
import { readSpawnfileContext } from './context.js';

export async function prepareSpawnfileInputs(args: CliArguments, io: CliIO, integration?: SpawnfileCliIntegration) {
  const context = readSpawnfileContext(resolve(io.cwd, one(args, 'spawnfile-context')));
  for (const flag of ['runtime', 'instructions', 'supporting', 'locked', 'source-root']) {
    if (args.flags[flag]) throw new Error(`--${flag} cannot replace canonical Spawnfile configuration`);
  }
  const model = one(args, 'model', context.agent.model?.name);
  const editable = args.flags.editable ?? [];
  if (new Set(editable).size !== editable.length) throw new Error('Editable selections must be unique');
  const resources: ResourceMapping[] = context.documents.map(document => ({
    id: `document-${createHash('sha256').update(document.destinationPath).digest('hex').slice(0, 16)}`,
    sourcePath: document.destinationPath,
    destinations: [{ kind: document.role === 'system' ? 'instructions' : 'supporting-files', path: document.destinationPath }],
    edit: editable.includes(document.destinationPath) && document.role === 'system'
      ? integration?.editPolicies?.[document.destinationPath] ?? 'whole-file' : 'locked',
  }));
  for (const skill of context.skills) resources.push({ id: `skill-${createHash('sha256').update(skill.destinationPath).digest('hex').slice(0, 16)}`,
    sourcePath: skill.destinationPath, destinations: [{ kind: 'native-skills', path: skill.destinationPath }],
    edit: editable.includes(skill.destinationPath) ? integration?.editPolicies?.[skill.destinationPath] ?? 'whole-file' : 'locked' });
  if (editable.some(path => !resources.some(resource => resource.sourcePath === path && resource.edit !== 'locked'))) {
    throw new Error('Editable paths must select canonical system instructions or textual skills; identity and policy remain locked');
  }
  const candidate = await snapshotCandidate({ sourceRoot: context.project.root, resources });
  for (const resource of candidate.resources) {
    if (context.sources.find(source => source.destinationPath === resource.sourcePath)?.sha256 !== resource.sourceDigest) {
      throw new Error('Canonical source changed while selecting the candidate');
    }
  }
  const judges = pairs(args.flags.judge ?? []);
  if (integration && (!integration.id.trim() || !integration.version.trim())) throw new Error('Project integration requires a stable id and version');
  return { runtime: context.agent.runtime, model, candidate, judges,
    citationRepairs: judgeCitationRepairs(args, judges),
    sourceRoot: context.project.root,
    out: resolve(io.cwd, one(args, 'out', args.flags['dry-run'] ? '.runtime/paideia' : undefined)),
    resources: Object.fromEntries(Object.entries(pairs(args.flags.resource ?? [])).map(([name, path]) => [name, resolve(io.cwd, path)])),
    datasets: new CliDatasets(judges, io.cwd, { subject: context.agent.name,
      registry: { preparations: integration?.preparations }, unlockedSetupPaths: integration?.unlockedSetupPaths }),
    maxTrials: count(args, 'max-trials', 20, 10000), context,
    readiness: { runnable: false, integration: integration ? { id: integration.id, version: integration.version } : null,
      reason: 'Native compilation, authentication and isolated startup are checked during execution. Dry-run probes none of them.' },
  };
}
