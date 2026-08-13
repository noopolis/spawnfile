import { describe, expect, it } from "vitest";

import { DOWN_RECEIPT_VERSION, parseDownReceipt, type DownReceipt } from "./downReceiptTypes.js";

const createReceipt = (overrides: Partial<DownReceipt> = {}): DownReceipt => ({
  deployment: "default",
  errors: [],
  retained_volumes: ["spawnfile-project-memory-office-recall-abc123"],
  units_stopped: ["default-container"],
  version: DOWN_RECEIPT_VERSION,
  ...overrides
});

describe("downReceiptSchema / parseDownReceipt", () => {
  it("round-trips a conformant receipt", () => {
    const receipt = createReceipt();
    expect(parseDownReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it("accepts empty arrays throughout (nothing removed, nothing retained, no errors)", () => {
    const receipt = createReceipt({ errors: [], retained_volumes: [], units_stopped: [] });
    expect(parseDownReceipt(receipt)).toEqual(receipt);
  });

  it("carries partial-failure messages in errors without rejecting the receipt", () => {
    const receipt = createReceipt({
      errors: ["unable to remove container spawnfile-project (unit default-container): timeout"]
    });
    expect(parseDownReceipt(receipt).errors).toHaveLength(1);
  });

  it("rejects an unknown version string", () => {
    expect(() => parseDownReceipt({ ...createReceipt(), version: "spawnfile.down-receipt.v2" })).toThrow(
      /invalid spawnfile\.down-receipt\.v1/
    );
  });

  it("rejects extra fields (strict schema)", () => {
    expect(() => parseDownReceipt({ ...createReceipt(), removed_volumes: [] })).toThrow();
  });
});
