import type { MeasurementRepairReceipt } from '../../experiments/repair/index.js';
import { trainingInferencePolicies } from '../../contracts/inference-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CliArguments } from '../arguments.js';
import type { CliDependencies, CliExecutionIdentityContext } from '../types.js';
import type { prepareCliInputs } from '../native.js';
import { readCliText } from '../datasets.js';

const stateSchema = z.object({schema:z.literal('paideia.command-checkpoint.v1'),id:z.string().uuid(),
  identity:z.string().regex(/^[a-f0-9]{64}$/),
  lineage:z.object({parentId:z.string(),parentIdentity:z.string(),receiptDigest:z.string()}).strict().optional()}).strict();

export async function commandCheckpoint(args: CliArguments, inputs: Awaited<ReturnType<typeof prepareCliInputs>>,
  dependencies: CliDependencies, context: CliExecutionIdentityContext = {},
  repair?: { receipt: MeasurementRepairReceipt; digest: string }) {
  const integration = dependencies.spawnfile;
  const environment = await integration?.executionIdentity?.(context);
  if ('context' in inputs && args.flags.resume && !environment) throw new Error('Resuming a native project requires its immutable execution identity');
  const flags = Object.fromEntries(Object.entries(args.flags).filter(([name]) =>
    !['resume','view','out','spawnfile-context','dry-run'].includes(name)).sort(([a],[b]) => a.localeCompare(b)));
  const identity = createHash('sha256').update(JSON.stringify({
    ...(repair ? {measurementRepair:repair.digest} : {}),
    version:'paideia.command-execution.v1',providerPolicies:trainingInferencePolicies(args.training, integration?.inferenceExecutionIdentity),flags,training:args.training,candidate:inputs.candidate.id,
    sourceRoot:inputs.sourceRoot,resources:inputs.resources,model:inputs.model,
    context:'context' in inputs ? inputs.context : null,
    integration:integration ? {id:integration.id,version:integration.version,environment:environment ?? null,
      subjectRoot:integration.subjectRoot ?? null,
      ...(integration.judgeCacheRoot === undefined ? {} : {judgeCacheRoot:integration.judgeCacheRoot})} : null,
  })).digest('hex');
  const directory = join(inputs.out,'checkpoint');
  await mkdir(directory,{recursive:true,mode:0o700});
  const path = join(directory,'command.json');
  if (args.flags.resume) {
    const state = stateSchema.parse(JSON.parse(readCliText(path,16384)));
    if (state.identity !== identity) throw new Error('Command checkpoint inputs changed; resume rejected');
    return {...state,directory,resume:true};
  }
  const state = {schema:'paideia.command-checkpoint.v1' as const,id:randomUUID(),identity,
    ...(repair ? {lineage:{parentId:repair.receipt.parent.experimentId,parentIdentity:repair.receipt.parent.executionIdentity,receiptDigest:repair.digest}} : {})};
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary,'wx',0o600);
  try {
    try {await file.writeFile(JSON.stringify(state));await file.sync();} finally {await file.close();}
    await link(temporary, path);
  } finally { await unlink(temporary); }
  const folder = await open(directory, 'r');
  try { await folder.sync(); } finally { await folder.close(); }
  return {...state,directory,resume:false};
}
