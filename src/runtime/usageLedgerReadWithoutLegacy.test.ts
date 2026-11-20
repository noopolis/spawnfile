import { expect, it, vi } from "vitest";

vi.mock("./legacyUsageLedger.generated.js", () => ({}));

import { readUsageLedgerViaExec } from "./usageLedgerRead.js";

it("does not treat a missing historical parser as a successful empty reading", async () => {
  const exec = vi.fn(async () => ({ stdout: "fixture", stderr: "" }));
  const paths = { filePath: "current", rotatedFilePath: "rotated" };
  await expect(readUsageLedgerViaExec(exec, paths)).rejects.toThrow(/No parser for the historical usage ledger/u);
  expect(exec).not.toHaveBeenCalled();

  await expect(readUsageLedgerViaExec(exec, paths, () => [])).resolves.toEqual({ records: [], unreadable: [] });
  expect(exec.mock.calls).toHaveLength(2);
});
