import type { CandidateManifest, CandidateResource, ResourceMapping } from './types.js';
import { readSourceFile } from './filesystem.js';
import { candidateIdentity, digestBytes, freezeCandidate, policyIdentity } from './identity.js';
import { validateCandidate, validateMappings } from './validation.js';

export async function snapshotCandidate(options: { sourceRoot: string; resources: ResourceMapping[] }): Promise<CandidateManifest> {
  validateMappings(options.resources);
  const seen = new Set<string>();
  const resources: CandidateResource[] = [];
  for (const mapping of options.resources) {
    const source = await readSourceFile(options.sourceRoot, mapping.sourcePath);
    if (seen.has(source.realPath)) throw new Error('Aliased source file has overlapping resource policies');
    seen.add(source.realPath);
    const digest = digestBytes(source.text);
    resources.push({ ...structuredClone(mapping), content: source.text, sourceContent: source.text, sourceDigest: digest, digest });
  }
  const body = { schema: 'paideia.candidate.v1' as const, parentId: null, policyDigest: policyIdentity(resources), resources };
  const id = candidateIdentity(body);
  const manifest = { ...body, id, baselineId: id };
  validateCandidate(manifest);
  return freezeCandidate(manifest);
}
