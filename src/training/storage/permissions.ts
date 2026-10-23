import type { ReadAccess, RunManifest, Visibility } from './types.js';
import { assertIdentity } from './content.js';

export function validateManifest(manifest: RunManifest): void {
  if (manifest.schema !== 'paideia.run.v1') throw new Error('Unsupported stored run schema');
  for (const value of [manifest.id, manifest.datasetId, manifest.candidateId, manifest.planDigest]) assertIdentity(value);
  if (!['train', 'validation', 'test'].includes(manifest.datasetRole)) throw new Error('Invalid dataset role');
  for (const key of Object.keys(manifest)) if (!['schema', 'id', 'datasetId', 'datasetRole', 'candidateId', 'planDigest', 'recordId', 'metadata'].includes(key)) throw new Error(`Unknown manifest field: ${key}`);
  if (manifest.recordId !== undefined) assertIdentity(manifest.recordId);
}
export function validateVisibility(visibility: Visibility): void {
  if (!['public', 'evaluator', 'raw'].includes(visibility)) throw new Error('Invalid visibility');
}
export function assertRunAccess(manifest: RunManifest, access: ReadAccess): void {
  if (!['optimizer', 'evaluator', 'viewer', 'operator'].includes(access.audience) ||
    !['training', 'validation', 'test', 'replay'].includes(access.phase)) throw new Error('Invalid read authorization');
  if (access.audience === 'optimizer' && manifest.datasetRole !== 'train') throw new Error('Optimizer cannot read validation or sealed test data');
  if (manifest.datasetRole === 'test') {
    const frozen = access.frozenCandidateIds?.includes(manifest.candidateId);
    const phase = access.phase === 'test' || (access.phase === 'replay' && access.releaseTestResults === true);
    if (!frozen || !phase) throw new Error('Sealed test access requires an authorized frozen candidate and phase');
    if (access.audience === 'viewer' && access.releaseTestResults !== true) throw new Error('Sealed test results have not been released to the viewer');
  }
}
export function canReadVisibility(visibility: Visibility, access: ReadAccess): boolean {
  validateVisibility(visibility);
  return visibility === 'public' || access.audience === 'operator' ||
    (visibility === 'evaluator' && access.audience === 'evaluator');
}
