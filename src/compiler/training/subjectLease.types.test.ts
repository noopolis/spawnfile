import { describe, expect, it } from "vitest";

import type { TrainingSubjectLease } from "./subjectLease.js";

/**
 * Restated from Paideia `src/adapters/daimon-native/preparation/types.ts` (`ProvisionedSubject`) and the
 * launch.v2 receipt shapes in `receipt/schema.ts`. Paideia is not a dependency; this copy is the structural
 * contract, so a lease key rename (for example `ports.control`) fails `npm run typecheck`.
 */
interface PaideiaBroker {
  projectionVersion: "noopolis.daimon.grok-broker-projection.v3";
  workerConfigVariant: "unclocked" | "clocked";
  projectionSha256: string;
  slot: number;
  workerUid: number;
  workerHomePath: string;
  architecture: "arm64" | "x64";
  usageLedgerPath: string;
  seccompProfileSha256: string;
  profileSha256: string;
  denyPaths: string[];
  limits: { maxRequests: number; maxTokens: number; timeoutMs: number };
  evaluatorPaths: { role: "run-root" | "context" | "sealed-inputs" | "judge-home" | "slot-ledger"; path: string }[];
  slotPreflightReceipt: string;
  expectedNonce: string;
  minGeneration: number;
}
interface PaideiaProvisionedSubject {
  agent: { id: string; engine: "codex"; model: string }
    | { id: string; engine: "grok"; model: "grok-4.6" | "grok-4.5" | "grok-build"; reasoningEffort: "low" | "medium" | "high" };
  workspace: { source: string; target: string };
  projections: { role: "home" | "memory" | "transport"; source: string; target: string }[];
  credentials: { source: string; target: string }[];
  broker?: PaideiaBroker;
  roots: Readonly<Record<string, string>> & { readonly workspace: string; readonly home: string; readonly control: string };
  ports: Readonly<Record<string, number>> & { readonly control: number };
  generation?: number;
  env: Readonly<Record<string, string>>;
}

describe("TrainingSubjectLease", () => {
  it("is assignable to Paideia's ProvisionedSubject without casts", () => {
    const check = (lease: TrainingSubjectLease): PaideiaProvisionedSubject => lease;
    expect(check).toBeTypeOf("function");
  });
});
