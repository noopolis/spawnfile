import { describe, expect, it } from "vitest";

import * as target from "./index.js";

describe("target public boundary", () => {
  it("exports provider-neutral cleanup, evidence, and recovery contracts", () => {
    expect(target.createCleanupRunOperations).toBeTypeOf("function");
    expect(target.targetResourceRequestSchema).toBeDefined();
    expect(target.targetResourceExportIndexSchema).toBeDefined();
    expect(target.parseTargetResourceExportIndex).toBeTypeOf("function");
    expect(target.initializeTargetJournal).toBeTypeOf("function");
    expect(target.lookupTargetOperation).toBeTypeOf("function");
    expect(target.parseTargetOperationLookup).toBeTypeOf("function");
    expect(target.parseTargetWorldReadinessRequest).toBeTypeOf("function");
    expect(target.verifyTargetWorldReadinessReceipt).toBeTypeOf("function");
  });

  it("keeps provider cleanup and evidence lowerings private", () => {
    const forbiddenRuntimeSymbols = [
      "createDockerCleanupRunOperations",
      "prepareDockerCleanupRun",
      "createEvidenceExportOperations",
      "createEvidenceVolumeExport",
      "EvidenceExportIncompleteError",
      "isEvidenceExportIncomplete",
      "resolveDockerContextEndpoint",
      "resolveSelectedTargetBinding",
      "ResolvedSelectedTargetBinding",
      "openExistingTargetJournalAuthority",
      "findExistingTargetJournalRoot",
      "prepareTargetJournalRoot",
      "readTargetJournalFile"
    ] as const;
    expect(forbiddenRuntimeSymbols.filter((symbol) => symbol in target)).toEqual([]);
  });
});
