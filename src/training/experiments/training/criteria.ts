import type { ResolvedDataset } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationRegistry } from '../../contracts/evaluation.js';
import { createHash } from 'node:crypto';

export async function freezeCriteria(dataset: ResolvedDataset, evaluation: Pick<EvaluationContext, 'judges' | 'embeddings' | 'readText'>,
  registry: EvaluationRegistry): Promise<Pick<EvaluationContext, 'judges' | 'embeddings' | 'readText'>> {
  for (const [key, version] of Object.entries(dataset.registryVersions)) {
    if (key.startsWith('evaluator:') && registry[key.slice(10)]?.definition.version !== version) throw new Error(`Evaluator version drift: ${key}`);
  }
  const sidecars = new Map<string, string>();
  for (const [path, expected] of Object.entries(dataset.criterionFileDigests)) {
    const bytes = await evaluation.readText(path);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expected) throw new Error(`Criterion sidecar changed: ${path}`);
    sidecars.set(path, bytes);
  }
  return { ...evaluation, readText: async path => {
    const bytes = sidecars.get(path);
    if (bytes === undefined) throw new Error(`Unfrozen criterion sidecar: ${path}`);
    return bytes;
  } };
}
