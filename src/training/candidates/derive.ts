import type { CandidateComponent, CandidateManifest, CandidateResource } from './types.js';
import { selectSections } from './headings.js';
import { candidateIdentity, digestBytes, freezeCandidate } from './identity.js';
import { assertOriginalPolicy, validateCandidate } from './validation.js';

function componentId(resourceId: string, heading?: string[]): string {
  return heading ? `${resourceId}#${heading.map(encodeURIComponent).join('/')}` : `${resourceId}#file`;
}
export function candidateComponents(candidate: CandidateManifest): CandidateComponent[] {
  validateCandidate(candidate);
  return candidate.resources.flatMap(resource => {
    if (resource.edit === 'locked') return [];
    if (resource.edit === 'whole-file') return [{ id: componentId(resource.id), resourceId: resource.id, text: resource.content }];
    return selectSections(resource.content, resource.edit.headings).map(section => ({
      id: componentId(resource.id, section.ancestry), resourceId: resource.id,
      heading: section.ancestry, text: resource.content.slice(section.start, section.end),
    }));
  });
}
export function deriveCandidate(baseline: CandidateManifest, parent: CandidateManifest,
  replacements: Readonly<Record<string, string>>): CandidateManifest {
  assertOriginalPolicy(baseline, parent);
  const components = candidateComponents(parent);
  for (const [id, text] of Object.entries(replacements)) {
    if (!components.some(component => component.id === id)) throw new Error(`Undeclared or locked candidate component: ${id}`);
    if (typeof text !== 'string') throw new Error('Candidate replacement must be text');
  }
  const resources = parent.resources.map(resource => replaceResource(resource, replacements));
  const body = { schema: parent.schema, parentId: parent.id, policyDigest: baseline.policyDigest, resources };
  const candidate = { ...body, baselineId: baseline.id, id: candidateIdentity(body, baseline.id) };
  assertOriginalPolicy(baseline, candidate);
  return freezeCandidate(candidate);
}
function replaceResource(resource: CandidateResource, replacements: Readonly<Record<string, string>>): CandidateResource {
  let content = resource.content;
  if (resource.edit === 'whole-file') {
    content = replacements[componentId(resource.id)] ?? content;
  } else if (typeof resource.edit === 'object') {
    const sections = selectSections(content, resource.edit.headings).reverse();
    for (const section of sections) {
      const replacement = replacements[componentId(resource.id, section.ancestry)];
      if (replacement !== undefined) content = content.slice(0, section.start) + replacement + content.slice(section.end);
    }
  }
  return { ...structuredClone(resource), content, digest: digestBytes(content) };
}
