import type { ContainerPersistentMountReport, ContainerRuntimeInstanceReport } from "../report/index.js";
import type { CompilePlanNode } from "../compiler/types.js";
import type { UsageLedgerPaths } from "./usageLedgerRead.js";
import type { UsageRecord } from "./usageTypes.js";

export interface RuntimeDrainTarget {
  containerRef: string;
  dockerArgs: readonly string[];
  dockerCommand: string;
  imageRef: string;
  token: string;
  runtime?: string;
}

export interface RuntimeAvailability {
  drain: "draining" | "drained" | null;
  state: string;
}

export interface RuntimeDrainOperations {
  controlTokenEnv?: string;
  drain(target: RuntimeDrainTarget): Promise<RuntimeAvailability>;
  resume(target: RuntimeDrainTarget): Promise<RuntimeAvailability>;
  availability(target: RuntimeDrainTarget): Promise<RuntimeAvailability>;
}

export interface RuntimeReadinessEvidence {
  receiptPath: string;
  expected: unknown;
}

export interface RuntimeReadinessOperations {
  compileEvidence(instance: ContainerRuntimeInstanceReport): RuntimeReadinessEvidence;
  validateReceipt(expected: unknown, receipt: string): boolean;
}

export interface RuntimeRecordingFacts {
  directory: string;
  mountId: string;
}

export interface RuntimeRecordingOperations {
  assertSupported(authorityOverride?: unknown): Promise<void>;
  facts(node: Pick<CompilePlanNode, "id" | "slug">): RuntimeRecordingFacts;
}

export interface RuntimeExportFile {
  relativePath: string;
  source:
    | { kind: "volume"; volumeName: string; volumePath: string }
    | { kind: "container"; containerPath: string };
  optional: boolean;
}

export interface RuntimePrivateExportDirectory {
  readonly containerPath: string;
  readonly relativePath: string;
}

export interface RuntimeUsageOperations {
  /** Older deployment records contain instance ids but omit runtime names. */
  matchesLegacyInstance?(id: string): boolean;
  livePaths: UsageLedgerPaths;
  exportedPaths: UsageLedgerPaths;
  maxReadBytes: number;
  mountId: string;
  volumePaths: UsageLedgerPaths;
  parse(text: string): UsageRecord[];
}

export interface RuntimeOperations {
  drain?: RuntimeDrainOperations;
  readiness?: RuntimeReadinessOperations;
  recording?: RuntimeRecordingOperations;
  exportFiles?(instance: ContainerRuntimeInstanceReport, mounts: ReadonlyMap<string, ContainerPersistentMountReport>): RuntimeExportFile[];
  privateExportDirectories?(instance: ContainerRuntimeInstanceReport): readonly RuntimePrivateExportDirectory[];
  usage?: RuntimeUsageOperations;
}
