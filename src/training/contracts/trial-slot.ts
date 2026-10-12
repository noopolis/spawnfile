/** Provisioner-owned isolated resources, opaque to experiment policy. */
export interface TrialSlot {
  index: number;
  workerUid: number;
  roots: Readonly<Record<string, string>>;
  ports: { base: number; count: number };
}
