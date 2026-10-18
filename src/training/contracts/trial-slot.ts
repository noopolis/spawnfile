/** Provisioner-owned isolated resources, opaque to experiment policy. */
export interface TrialSlot {
  /** v2 native slots share the container uid; v1 retains distinct worker identities. */
  isolation?: 'shared-uid';
  index: number;
  workerUid: number;
  roots: Readonly<Record<string, string>>;
  ports: { base: number; count: number };
}
