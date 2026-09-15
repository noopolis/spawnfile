import type { CandidateManifest } from './types.js';
import { candidateIdentity, digestBytes, freezeCandidate } from './identity.js';
import { assertOriginalPolicy, validateCandidate } from './validation.js';

/** Replace authored resource bytes exactly, retaining the baseline's declared edit policy. */
export function deriveAuthoredCandidate(baseline: CandidateManifest, replacements: Readonly<Record<string, string>>): CandidateManifest {
  validateCandidate(baseline);
  if (!Object.keys(replacements).length) throw new Error('Authored comparison requires resource replacements');
  for (const [path, text] of Object.entries(replacements)) {
    const resource = baseline.resources.find(item => item.sourcePath === path);
    if (!resource || resource.edit === 'locked') throw new Error(`Undeclared or locked comparison resource: ${path}`);
    if (typeof text !== 'string') throw new Error('Authored replacement must be text');
  }
  const resources = baseline.resources.map(resource => {
    const content = replacements[resource.sourcePath] ?? resource.content;
    return { ...structuredClone(resource), content, digest: digestBytes(content) };
  });
  if (resources.every((resource, index) => resource.content === baseline.resources[index]!.content)) {
    throw new Error('Authored candidate must differ from the baseline');
  }
  const body = { schema: baseline.schema, parentId: baseline.id, policyDigest: baseline.policyDigest, resources };
  const candidate = { ...body, baselineId: baseline.id, id: candidateIdentity(body, baseline.id) };
  assertOriginalPolicy(baseline, candidate);
  return freezeCandidate(candidate);
}
