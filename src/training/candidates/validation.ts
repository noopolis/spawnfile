import type { CandidateManifest, CandidateResource, ResourceMapping } from './types.js';
import { candidateIdentity, canonicalCandidate, digestBytes, policyIdentity } from './identity.js';
import { relativeResourcePath } from './filesystem.js';
import { lockedSegments, selectSections } from './headings.js';

export function validateMappings(resources: ResourceMapping[]): void {
  if (!Array.isArray(resources) || !resources.length || resources.length > 256) throw new Error('Candidate requires 1..256 explicit resources');
  const ids = new Set<string>();
  const sources = new Set<string>();
  const paths: string[] = [];
  for (const resource of resources) {
    if (typeof resource.id !== 'string' || !/^[A-Za-z][\w.-]{0,119}$/.test(resource.id) || ids.has(resource.id)) throw new Error('Invalid or duplicate candidate resource ID');
    ids.add(resource.id);
    relativeResourcePath(resource.sourcePath);
    if (sources.has(resource.sourcePath)) throw new Error('Source file has overlapping resource policies');
    sources.add(resource.sourcePath);
    if (!Array.isArray(resource.destinations) || !resource.destinations.length) throw new Error('Every candidate resource requires native destinations');
    for (const destination of resource.destinations) {
      if (!['instructions', 'supporting-files', 'native-skills'].includes(destination.kind)) throw new Error('Unsupported native resource kind');
      relativeResourcePath(destination.path);
      if (paths.some(path => path === destination.path || path.startsWith(`${destination.path}/`) || destination.path.startsWith(`${path}/`))) throw new Error('Native destinations overlap');
      paths.push(destination.path);
    }
    if (resource.edit !== 'locked' && resource.edit !== 'whole-file' &&
      (!resource.edit || typeof resource.edit !== 'object' || !Array.isArray(resource.edit.headings) || Object.keys(resource.edit).length !== 1)) {
      throw new Error('Unsupported candidate edit policy');
    }
  }
}
export function validateCandidate(candidate: CandidateManifest): void {
  if (candidate.schema !== 'paideia.candidate.v1') throw new Error('Unsupported candidate schema');
  validateMappings(candidate.resources);
  let bytes = 0;
  for (const resource of candidate.resources) {
    if (typeof resource.content !== 'string' || resource.content.includes('\0') || Buffer.byteLength(resource.content) > 1_048_576) throw new Error('Candidate resource must be bounded text');
    if (Buffer.from(resource.content).toString('utf8') !== resource.content) throw new Error('Candidate resource must contain valid UTF-8 text');
    bytes += Buffer.byteLength(resource.content);
    if (resource.digest !== digestBytes(resource.content)) throw new Error('Candidate resource digest mismatch');
    if (typeof resource.sourceContent !== 'string' || resource.sourceDigest !== digestBytes(resource.sourceContent)) throw new Error('Invalid candidate source digest');
    assertLockedBytes({ ...resource, content: resource.sourceContent }, resource);
    if (typeof resource.edit === 'object') selectSections(resource.content, resource.edit.headings);
  }
  if (bytes > 16_777_216) throw new Error('Candidate exceeds 16 MiB');
  if (candidate.policyDigest !== policyIdentity(candidate.resources)) throw new Error('Candidate policy digest mismatch');
  const { id, baselineId, ...identity } = candidate;
  if (id !== candidateIdentity(identity, candidate.parentId === null ? undefined : baselineId)) throw new Error('Candidate identity mismatch');
  const original = { schema: candidate.schema, parentId: null, policyDigest: candidate.policyDigest, resources: candidate.resources.map(resource => ({ ...resource, content: resource.sourceContent, digest: resource.sourceDigest })) };
  if (candidate.baselineId !== candidateIdentity(original) || (candidate.parentId === null && baselineId !== id)) throw new Error('Invalid candidate baseline');
}
export function assertOriginalPolicy(baseline: CandidateManifest, candidate: CandidateManifest): void {
  validateCandidate(baseline);
  validateCandidate(candidate);
  if (baseline.parentId !== null || candidate.baselineId !== baseline.id || candidate.policyDigest !== baseline.policyDigest) throw new Error('Candidate must retain its original baseline policy');
  for (const original of baseline.resources) {
    const resource = candidate.resources.find(item => item.id === original.id)!;
    assertLockedBytes(original, resource);
  }
}
function assertLockedBytes(original: CandidateResource, resource: CandidateResource): void {
  if (original.edit === 'whole-file') return;
  if (original.edit === 'locked') {
    if (resource.content !== original.content) throw new Error(`Locked resource changed: ${original.id}`);
    return;
  }
  const before = selectSections(original.content, original.edit.headings);
  const after = selectSections(resource.content, original.edit.headings);
  if (canonicalCandidate(lockedSegments(original.content, before)) !== canonicalCandidate(lockedSegments(resource.content, after))) {
    throw new Error(`Locked heading text or remainder changed: ${original.id}`);
  }
}
