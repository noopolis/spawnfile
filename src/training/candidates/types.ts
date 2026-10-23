export type ResourceKind = 'instructions' | 'supporting-files' | 'native-skills';
export interface NativeDestination { kind: ResourceKind; path: string }
export type EditPolicy = 'locked' | 'whole-file' | { headings: string[][] };
export interface ResourceMapping {
  id: string;
  sourcePath: string;
  destinations: NativeDestination[];
  edit: EditPolicy;
}
export interface CandidateResource extends ResourceMapping {
  content: string;
  /** Original bytes permit independent verification of every locked region. */
  sourceContent: string;
  sourceDigest: string;
  digest: string;
}
export interface CandidateManifest {
  schema: 'paideia.candidate.v1';
  id: string;
  baselineId: string;
  parentId: string | null;
  policyDigest: string;
  resources: CandidateResource[];
}
export interface CandidateComponent {
  id: string;
  resourceId: string;
  heading?: string[];
  text: string;
}
export interface MaterializationReceipt {
  resourceId: string;
  destination: NativeDestination;
  digest: string;
  evidence: 'installed';
}
