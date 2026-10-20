import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { NativeTrialServices, SpawnfileCliIntegration } from '../types.js';
import type { SpawnfileTrainingContext } from './context.js';
import type { NativePreparationContext, StoredTrialOptions } from '../../experiments/index.js';

const absolute = z.string().refine(value => isAbsolute(value) && resolve(value) === value);
const instant = z.iso.datetime({ offset: true });
const momentSchema = z.object({
  version: z.literal('spawnfile.training-moment-case.v1'), projectRoot: absolute,
  agent: z.string().min(1), example: z.string().min(1), role: z.enum(['train', 'validation', 'test']),
  dataset: z.string().min(1), at: instant, effectiveAt: instant,
  wake: z.object({ surface: z.literal('moltnet'), room: z.string().min(1), from: z.string().min(1), text: z.string().min(1) }).strict(),
  group: z.string().min(1), lineage: z.string().min(1), momentRoot: absolute,
  historyDir: absolute.optional(), hook: z.string().min(1),
}).strict();

/** Frozen authored metadata; the lowered bundle is never reused as writable trial state. */
export type TrainingMomentCase = z.infer<typeof momentSchema>;
export interface TrainingMomentReceipt {
  version: 'paideia.training-moment-prepared.v1';
  trialId: string;
  example: string;
  momentRoot: string;
  at: string;
}
export type TrainingMomentPreparation = (
  paths: Parameters<NonNullable<StoredTrialOptions['prepareEnvironment']>>[0], signal: AbortSignal,
  trial: NativePreparationContext, context: SpawnfileTrainingContext, moment: TrainingMomentCase, services: NativeTrialServices,
) => Promise<Awaited<ReturnType<NonNullable<StoredTrialOptions['prepareEnvironment']>>> & {
  momentReceipt: TrainingMomentReceipt;
}>;

async function boundedJson(path: string): Promise<Record<string, unknown>> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Moment evidence must be a bounded regular file');
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/** Static hook registration, fresh destination and rewind evidence are required before subject start. */
export function spawnfileEnvironment(integration: SpawnfileCliIntegration, context: SpawnfileTrainingContext,
  services: NativeTrialServices): NonNullable<StoredTrialOptions['prepareEnvironment']> {
  return async (paths, signal, trial) => {
    const declared = trial.record.setup?.trainingMoment;
    if (declared === undefined) return integration.prepareEnvironment(paths, signal, trial, context, services);
    const moment = momentSchema.parse(declared);
    const id = moment.example.slice(moment.role.length + 1);
    // An internal holdout changes evaluation phase, never the authored rewind selector.
    const phaseMatches = moment.role === trial.phase || (moment.role === 'train' && trial.phase === 'validation');
    if (!moment.example.startsWith(`${moment.role}:`) || id !== trial.record.id || !phaseMatches ||
        moment.agent !== context.agent.id || moment.projectRoot !== context.project.root ||
        moment.group !== trial.record.group || JSON.stringify([moment.lineage]) !== JSON.stringify(trial.record.lineage)) {
      throw new Error('Training moment case identity mismatch');
    }
    const hooks = integration.momentPreparations;
    if (!hooks || !Object.hasOwn(hooks, moment.hook)) throw new Error(`Undeclared training moment hook: ${moment.hook}`);
    const destination = join(paths.control, 'moment');
    if (await lstat(destination).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    })) throw new Error('Training moment destination is not fresh');
    signal.throwIfAborted();
    const prepared = await hooks[moment.hook]!(paths, signal, trial, context, moment, services);
    signal.throwIfAborted();
    const receipt = prepared.momentReceipt;
    if (!receipt || receipt.version !== 'paideia.training-moment-prepared.v1' || receipt.trialId !== trial.id ||
        receipt.example !== moment.example || receipt.at !== moment.effectiveAt || receipt.momentRoot !== destination) {
      throw new Error('Training moment preparation receipt mismatch');
    }
    if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) throw new Error('Training moment root is not an isolated real directory');
    const evidence = await boundedJson(join(destination, 'moment.json'));
    const example = evidence.example as Record<string, unknown> | undefined;
    const leak = evidence.leakCheck as Record<string, unknown> | undefined;
    if (evidence.version !== 'spawnfile.materialized-moment.v1' || evidence.status !== 'materialized' ||
        evidence.agent !== moment.agent || evidence.at !== moment.at || evidence.effectiveAt !== moment.effectiveAt ||
        example?.id !== id || example.role !== moment.role || example.dataset !== moment.dataset || leak?.ok !== true) {
      throw new Error('Training moment rewind evidence mismatch or refusal');
    }
    const check = await boundedJson(join(destination, 'leak-check.json'));
    if (check.ok !== true) throw new Error('Training moment leak check refused');
    const { momentReceipt: _receipt, ...environment } = prepared;
    return environment;
  };
}
