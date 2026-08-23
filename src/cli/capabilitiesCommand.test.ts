import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerCapabilitiesCommand } from "./capabilitiesCommand.js";

describe("capabilities command", () => {
  it("writes exactly one receipt", async () => {
    const stdout: string[] = [];
    const program = new Command().exitOverride();
    registerCapabilitiesCommand(program, { stderr: () => undefined, stdout: (value) => stdout.push(value) }, "0.1.17");
    await program.parseAsync(["capabilities", "--json"], { from: "user" });
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      implementation: { version: "0.1.17" }, version: "spawnfile.capabilities.v1",
    });
  });
});
