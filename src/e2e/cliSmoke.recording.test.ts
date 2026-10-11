import { describe, expect, it, vi } from "vitest";

vi.mock("./daimonOrg.js", () => ({ runDaimonOrgE2E: vi.fn() }));

import { runDaimonOrgCli } from "./cliSmoke.js";
import { runDaimonOrgE2E } from "./daimonOrg.js";

describe("local-rootfs E2E recorded memory override", () => {
  it("forwards only the explicit discard flag", async () => {
    vi.mocked(runDaimonOrgE2E).mockRejectedValue(new Error("stop before execution"));
    for (const override of [false, true]) {
      await expect(runDaimonOrgCli(override ? ["--discard-recorded-memory"] : []))
        .rejects.toThrow("stop before execution");
      expect(runDaimonOrgE2E).toHaveBeenLastCalledWith(expect.objectContaining({
        discardRecordedMemory: override ? true : undefined,
      }));
    }
  });
});
